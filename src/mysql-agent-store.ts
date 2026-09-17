import { randomUUID } from 'node:crypto'

import mysql, {
  type Pool,
  type PoolConnection,
  type ResultSetHeader,
  type RowDataPacket,
} from 'mysql2/promise'

import type {
  AgentSessionSnapshot,
  AgentStep,
  AgentTurn,
  SessionRecord,
  SessionStore,
  StepStatus,
  TurnStatus,
} from './session-store.ts'
import type { AgentProject, ProjectRoot, ProjectStore } from './project.ts'
import type { ToolCall } from './types.ts'

export interface MysqlAgentStoreOptions {
  host: string
  port: number
  user: string
  password: string
  database: string
  connectionLimit?: number
}

/** MySQL adapter for durable Projects, Sessions, Turns, and Steps. */
export class MysqlAgentStore implements SessionStore, ProjectStore {
  private constructor(private readonly pool: Pool) {}

  static async connect(options: MysqlAgentStoreOptions): Promise<MysqlAgentStore> {
    const pool = mysql.createPool({
      ...options,
      connectionLimit: options.connectionLimit ?? 10,
      charset: 'utf8mb4',
      timezone: 'Z',
    })
    try {
      await migrate(pool)
      return new MysqlAgentStore(pool)
    } catch (error: unknown) {
      await pool.end()
      throw error
    }
  }

  async createSession(projectId: string | null): Promise<string> {
    const id = randomUUID()
    await this.pool.execute(
      `INSERT INTO agent_sessions (id, project_id, status) VALUES (?, ?, 'active')`,
      [id, projectId],
    )
    return id
  }

  async loadSession(sessionId: string): Promise<AgentSessionSnapshot | undefined> {
    const [sessionRows] = await this.pool.execute<SessionRow[]>(
      'SELECT id, project_id, status FROM agent_sessions WHERE id = ?',
      [sessionId],
    )
    const session = sessionRows[0]
    if (!session) return undefined

    const [turnRows] = await this.pool.execute<TurnRow[]>(
      `SELECT id, turn_number, status, prompt, error_message
       FROM agent_turns
       WHERE session_id = ?
       ORDER BY turn_number`,
      [sessionId],
    )
    const [stepRows] = await this.pool.execute<StepRow[]>(
      `SELECT s.turn_id, s.step_number, s.status, s.output_kind,
              s.assistant_content, s.tool_call_id, s.tool_name,
              s.tool_arguments, s.tool_result, s.error_message
       FROM agent_steps AS s
       INNER JOIN agent_turns AS t ON t.id = s.turn_id
       WHERE t.session_id = ?
       ORDER BY t.turn_number, s.step_number`,
      [sessionId],
    )

    const stepsByTurn = new Map<string, AgentStep[]>()
    for (const row of stepRows) {
      const steps = stepsByTurn.get(row.turn_id) ?? []
      steps.push(toStep(row))
      stepsByTurn.set(row.turn_id, steps)
    }

    return {
      id: session.id,
      projectId: session.project_id,
      status: readSessionStatus(session.status),
      turns: turnRows.map(row => toTurn(row, stepsByTurn.get(row.id) ?? [])),
    }
  }

  async createProject(input: {
    name: string
    roots: readonly ProjectRoot[]
  }): Promise<AgentProject> {
    validateProjectRoots(input.roots)
    const id = randomUUID()
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      await connection.execute(
        'INSERT INTO agent_projects (id, name) VALUES (?, ?)',
        [id, input.name],
      )
      for (const root of input.roots) {
        await connection.execute(
          `INSERT INTO agent_project_roots (id, project_id, root_path, root_role)
           VALUES (?, ?, ?, ?)`,
          [randomUUID(), id, root.path, root.role],
        )
      }
      await connection.commit()
    } catch (error: unknown) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
    return { id, name: input.name, roots: structuredClone(input.roots) }
  }

  async loadProject(projectId: string): Promise<AgentProject | undefined> {
    const projects = await loadProjects(this.pool, 'WHERE p.id = ?', [projectId])
    return projects[0]
  }

  async listProjects(): Promise<readonly AgentProject[]> {
    return await loadProjects(this.pool, '', [])
  }

  async record(sessionId: string, record: SessionRecord): Promise<void> {
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      await lockSession(connection, sessionId)
      await applyRecord(connection, sessionId, record)
      await connection.execute(
        'UPDATE agent_sessions SET updated_at = CURRENT_TIMESTAMP(6) WHERE id = ?',
        [sessionId],
      )
      await connection.commit()
    } catch (error: unknown) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}

interface SessionRow extends RowDataPacket {
  id: string
  project_id: string | null
  status: string
}

interface TurnRow extends RowDataPacket {
  id: string
  turn_number: number
  status: string
  prompt: string
  error_message: string | null
}

interface StepRow extends RowDataPacket {
  turn_id: string
  step_number: number
  status: string
  output_kind: string
  assistant_content: string | null
  tool_call_id: string | null
  tool_name: string | null
  tool_arguments: unknown
  tool_result: string | null
  error_message: string | null
}

interface ProjectWithRootRow extends RowDataPacket {
  id: string
  name: string
  root_path: string | null
  root_role: string | null
}

async function loadProjects(
  pool: Pool,
  whereClause: string,
  values: readonly string[],
): Promise<AgentProject[]> {
  const [rows] = await pool.execute<ProjectWithRootRow[]>(
    `SELECT p.id, p.name, r.root_path, r.root_role
     FROM agent_projects AS p
     LEFT JOIN agent_project_roots AS r ON r.project_id = p.id
     ${whereClause}
     ORDER BY p.created_at, r.primary_slot DESC, r.created_at`,
    [...values],
  )
  const projects = new Map<string, { id: string; name: string; roots: ProjectRoot[] }>()
  for (const row of rows) {
    const project = projects.get(row.id) ?? { id: row.id, name: row.name, roots: [] }
    if (row.root_path !== null && row.root_role !== null) {
      project.roots.push({
        path: row.root_path,
        role: readProjectRootRole(row.root_role),
      })
    }
    projects.set(row.id, project)
  }
  const result = [...projects.values()]
  for (const project of result) validateProjectRoots(project.roots)
  return result
}

function validateProjectRoots(roots: readonly ProjectRoot[]): void {
  const primaryRoots = roots.filter(root => root.role === 'primary')
  if (primaryRoots.length !== 1) throw new Error('A project must have exactly one primary root')
  if (new Set(roots.map(root => root.path)).size !== roots.length) {
    throw new Error('A project cannot contain duplicate workspace roots')
  }
  if (roots.some(root => root.path.length === 0)) {
    throw new Error('A workspace root path must not be empty')
  }
}

function readProjectRootRole(value: string): 'primary' | 'attached' {
  if (value === 'primary' || value === 'attached') return value
  throw new Error(`Unknown project root role: ${value}`)
}

async function migrate(pool: Pool): Promise<void> {
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS agent_schema_migrations (
      version INT NOT NULL PRIMARY KEY,
      applied_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
    ) ENGINE=InnoDB
  `)
  const [rows] = await pool.execute<(RowDataPacket & { version: number | null })[]>(
    'SELECT MAX(version) AS version FROM agent_schema_migrations',
  )
  const version = rows[0]?.version ?? 0
  if (version > 2) throw new Error(`Database schema version ${version} is newer than supported version 2`)

  if (version < 1) {
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS agent_sessions (
        id VARCHAR(36) NOT NULL PRIMARY KEY,
        status VARCHAR(16) NOT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        CONSTRAINT chk_agent_sessions_status CHECK (status IN ('active'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `)
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS agent_turns (
        id VARCHAR(36) NOT NULL PRIMARY KEY,
        session_id VARCHAR(36) NOT NULL,
        turn_number INT UNSIGNED NOT NULL,
        status VARCHAR(16) NOT NULL,
        prompt LONGTEXT NOT NULL,
        error_message TEXT NULL,
        started_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        completed_at DATETIME(6) NULL,
        UNIQUE KEY uq_agent_turns_session_number (session_id, turn_number),
        KEY idx_agent_turns_session_status (session_id, status),
        CONSTRAINT fk_agent_turns_session FOREIGN KEY (session_id)
          REFERENCES agent_sessions (id) ON DELETE CASCADE,
        CONSTRAINT chk_agent_turns_status CHECK (status IN ('running', 'completed', 'failed'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `)
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS agent_steps (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        turn_id VARCHAR(36) NOT NULL,
        step_number INT UNSIGNED NOT NULL,
        status VARCHAR(16) NOT NULL,
        output_kind VARCHAR(16) NOT NULL,
        assistant_content LONGTEXT NULL,
        tool_call_id VARCHAR(255) NULL,
        tool_name VARCHAR(255) NULL,
        tool_arguments JSON NULL,
        tool_result LONGTEXT NULL,
        error_message TEXT NULL,
        started_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        completed_at DATETIME(6) NULL,
        UNIQUE KEY uq_agent_steps_turn_number (turn_id, step_number),
        CONSTRAINT fk_agent_steps_turn FOREIGN KEY (turn_id)
          REFERENCES agent_turns (id) ON DELETE CASCADE,
        CONSTRAINT chk_agent_steps_status CHECK (status IN ('running', 'completed', 'failed')),
        CONSTRAINT chk_agent_steps_kind CHECK (output_kind IN ('final', 'tool-call'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `)
    await pool.execute('INSERT IGNORE INTO agent_schema_migrations (version) VALUES (1)')
  }

  if (version < 2) {
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS agent_projects (
        id VARCHAR(36) NOT NULL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `)
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS agent_project_roots (
        id VARCHAR(36) NOT NULL PRIMARY KEY,
        project_id VARCHAR(36) NOT NULL,
        root_path VARCHAR(700) COLLATE utf8mb4_0900_bin NOT NULL,
        root_role VARCHAR(16) NOT NULL,
        primary_slot TINYINT GENERATED ALWAYS AS (
          CASE WHEN root_role = 'primary' THEN 1 ELSE NULL END
        ) STORED,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        UNIQUE KEY uq_agent_project_roots_path (project_id, root_path),
        UNIQUE KEY uq_agent_project_roots_primary (project_id, primary_slot),
        CONSTRAINT fk_agent_project_roots_project FOREIGN KEY (project_id)
          REFERENCES agent_projects (id) ON DELETE CASCADE,
        CONSTRAINT chk_agent_project_roots_role CHECK (root_role IN ('primary', 'attached'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `)
    await pool.execute(`
      ALTER TABLE agent_sessions
        ADD COLUMN project_id VARCHAR(36) NULL AFTER id,
        ADD KEY idx_agent_sessions_project (project_id),
        ADD CONSTRAINT fk_agent_sessions_project FOREIGN KEY (project_id)
          REFERENCES agent_projects (id) ON DELETE RESTRICT
    `)
    await pool.execute('INSERT IGNORE INTO agent_schema_migrations (version) VALUES (2)')
  }
}

async function lockSession(connection: PoolConnection, sessionId: string): Promise<void> {
  const [rows] = await connection.execute<RowDataPacket[]>(
    'SELECT id FROM agent_sessions WHERE id = ? FOR UPDATE',
    [sessionId],
  )
  if (rows.length === 0) throw new Error(`Unknown session: ${sessionId}`)
}

async function applyRecord(
  connection: PoolConnection,
  sessionId: string,
  record: SessionRecord,
): Promise<void> {
  switch (record.type) {
    case 'turn.started': {
      const [running] = await connection.execute<RowDataPacket[]>(
        `SELECT id FROM agent_turns
         WHERE session_id = ? AND status = 'running'
         LIMIT 1`,
        [sessionId],
      )
      if (running.length > 0) throw new Error(`Session ${sessionId} already has a running turn`)
      const [numbers] = await connection.execute<(RowDataPacket & { next_number: number })[]>(
        `SELECT COALESCE(MAX(turn_number), 0) + 1 AS next_number
         FROM agent_turns WHERE session_id = ?`,
        [sessionId],
      )
      const nextNumber = numbers[0]?.next_number
      if (nextNumber === undefined) throw new Error(`Cannot allocate turn number for ${sessionId}`)
      await connection.execute(
        `INSERT INTO agent_turns (id, session_id, turn_number, status, prompt)
         VALUES (?, ?, ?, 'running', ?)`,
        [record.turnId, sessionId, nextNumber, record.prompt],
      )
      return
    }
    case 'step.tool-called':
      await requireRunningTurn(connection, sessionId, record.turnId)
      await connection.execute(
        `INSERT INTO agent_steps
           (turn_id, step_number, status, output_kind, tool_call_id, tool_name, tool_arguments)
         VALUES (?, ?, 'running', 'tool-call', ?, ?, ?)`,
        [
          record.turnId,
          record.step,
          record.call.id,
          record.call.name,
          JSON.stringify(record.call.arguments),
        ],
      )
      return
    case 'step.tool-completed':
      await updateToolStep(connection, record, 'completed')
      return
    case 'step.tool-failed':
      await updateToolStep(connection, record, 'failed')
      return
    case 'step.finalized':
      await requireRunningTurn(connection, sessionId, record.turnId)
      await connection.execute(
        `INSERT INTO agent_steps
           (turn_id, step_number, status, output_kind, assistant_content, completed_at)
         VALUES (?, ?, 'completed', 'final', ?, CURRENT_TIMESTAMP(6))`,
        [record.turnId, record.step, record.content],
      )
      return
    case 'turn.completed': {
      const [result] = await connection.execute<ResultSetHeader>(
        `UPDATE agent_turns
         SET status = 'completed', completed_at = CURRENT_TIMESTAMP(6)
         WHERE id = ? AND session_id = ? AND status = 'running'
           AND EXISTS (
             SELECT 1 FROM agent_steps
             WHERE turn_id = ? AND output_kind = 'final' AND status = 'completed'
           )`,
        [record.turnId, sessionId, record.turnId],
      )
      requireChanged(result, `Cannot complete turn ${record.turnId}`)
      return
    }
    case 'turn.failed': {
      const [result] = await connection.execute<ResultSetHeader>(
        `UPDATE agent_turns
         SET status = 'failed', error_message = ?, completed_at = CURRENT_TIMESTAMP(6)
         WHERE id = ? AND session_id = ? AND status = 'running'`,
        [record.error, record.turnId, sessionId],
      )
      requireChanged(result, `Cannot fail turn ${record.turnId}`)
      return
    }
  }
}

async function requireRunningTurn(
  connection: PoolConnection,
  sessionId: string,
  turnId: string,
): Promise<void> {
  const [rows] = await connection.execute<RowDataPacket[]>(
    `SELECT id FROM agent_turns
     WHERE id = ? AND session_id = ? AND status = 'running'`,
    [turnId, sessionId],
  )
  if (rows.length === 0) throw new Error(`Turn ${turnId} is not running in session ${sessionId}`)
}

async function updateToolStep(
  connection: PoolConnection,
  record: Extract<SessionRecord, { type: 'step.tool-completed' | 'step.tool-failed' }>,
  status: 'completed' | 'failed',
): Promise<void> {
  const value = record.type === 'step.tool-completed' ? record.result : record.error
  const column = record.type === 'step.tool-completed' ? 'tool_result' : 'error_message'
  const [result] = await connection.execute<ResultSetHeader>(
    `UPDATE agent_steps
     SET status = ?, ${column} = ?, completed_at = CURRENT_TIMESTAMP(6)
     WHERE turn_id = ? AND step_number = ? AND tool_call_id = ?
       AND output_kind = 'tool-call' AND status = 'running'`,
    [status, value, record.turnId, record.step, record.toolCallId],
  )
  requireChanged(result, `Cannot ${status === 'completed' ? 'complete' : 'fail'} tool step ${record.step}`)
}

function requireChanged(result: ResultSetHeader, message: string): void {
  if (result.affectedRows !== 1) throw new Error(message)
}

function toTurn(row: TurnRow, steps: readonly AgentStep[]): AgentTurn {
  return {
    id: row.id,
    turnNumber: row.turn_number,
    status: readTurnStatus(row.status),
    prompt: row.prompt,
    steps,
    ...(row.error_message === null ? {} : { error: row.error_message }),
  }
}

function toStep(row: StepRow): AgentStep {
  const status = readStepStatus(row.status)
  if (row.output_kind === 'final') {
    if (row.assistant_content === null) throw new Error(`Final step ${row.step_number} has no content`)
    return {
      stepNumber: row.step_number,
      status,
      output: { kind: 'final', content: row.assistant_content },
    }
  }
  if (row.output_kind !== 'tool-call') {
    throw new Error(`Unknown step output kind: ${row.output_kind}`)
  }
  if (row.tool_call_id === null || row.tool_name === null || row.tool_arguments === null) {
    throw new Error(`Tool step ${row.step_number} is missing call data`)
  }

  const call: ToolCall = {
    id: row.tool_call_id,
    name: row.tool_name,
    arguments: parseJson(row.tool_arguments),
  }
  return {
    stepNumber: row.step_number,
    status,
    output: {
      kind: 'tool-call',
      call,
      ...(row.tool_result === null ? {} : { result: row.tool_result }),
      ...(row.error_message === null ? {} : { error: row.error_message }),
    },
  }
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch (error: unknown) {
    throw new Error('Stored tool arguments are not valid JSON', { cause: error })
  }
}

function readSessionStatus(value: string): 'active' {
  if (value !== 'active') throw new Error(`Unknown session status: ${value}`)
  return value
}

function readTurnStatus(value: string): TurnStatus {
  if (value === 'running' || value === 'completed' || value === 'failed') return value
  throw new Error(`Unknown turn status: ${value}`)
}

function readStepStatus(value: string): StepStatus {
  if (value === 'running' || value === 'completed' || value === 'failed') return value
  throw new Error(`Unknown step status: ${value}`)
}
