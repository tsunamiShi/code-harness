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
  AgentToolExecution,
  AgentTurn,
  SessionRecord,
  SessionStore,
  StepStatus,
  TurnStatus,
} from '../runtime/session-store.ts'
import type { AgentProject, ProjectRoot, ProjectStore } from '../projects/project.ts'

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
      `SELECT CAST(s.id AS CHAR) AS id, s.turn_id, s.step_number, s.status, s.output_kind,
              s.assistant_content
       FROM agent_steps AS s
       INNER JOIN agent_turns AS t ON t.id = s.turn_id
       WHERE t.session_id = ?
       ORDER BY t.turn_number, s.step_number`,
      [sessionId],
    )
    const [toolCallRows] = await this.pool.execute<ToolCallRow[]>(
      `SELECT CAST(c.step_id AS CHAR) AS step_id, c.call_index, c.status, c.tool_call_id,
              c.tool_name, c.tool_arguments, c.tool_result, c.error_message
       FROM agent_tool_calls AS c
       INNER JOIN agent_steps AS s ON s.id = c.step_id
       INNER JOIN agent_turns AS t ON t.id = s.turn_id
       WHERE t.session_id = ?
       ORDER BY t.turn_number, s.step_number, c.call_index`,
      [sessionId],
    )

    const toolCallsByStep = new Map<string, AgentToolExecution[]>()
    for (const row of toolCallRows) {
      const calls = toolCallsByStep.get(row.step_id) ?? []
      calls.push(toToolExecution(row))
      toolCallsByStep.set(row.step_id, calls)
    }

    const stepsByTurn = new Map<string, AgentStep[]>()
    for (const row of stepRows) {
      const steps = stepsByTurn.get(row.turn_id) ?? []
      steps.push(toStep(row, toolCallsByStep.get(row.id) ?? []))
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

  async attachRoot(projectId: string, path: string): Promise<AgentProject> {
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const [projects] = await connection.execute<RowDataPacket[]>(
        'SELECT id FROM agent_projects WHERE id = ? FOR UPDATE',
        [projectId],
      )
      if (projects.length === 0) throw new Error(`Unknown project: ${projectId}`)
      const [existing] = await connection.execute<RowDataPacket[]>(
        `SELECT id FROM agent_project_roots
         WHERE project_id = ? AND root_path = ?
         LIMIT 1`,
        [projectId, path],
      )
      if (existing.length === 0) {
        await connection.execute(
          `INSERT INTO agent_project_roots (id, project_id, root_path, root_role)
           VALUES (?, ?, ?, 'attached')`,
          [randomUUID(), projectId, path],
        )
        await connection.execute(
          'UPDATE agent_projects SET updated_at = CURRENT_TIMESTAMP(6) WHERE id = ?',
          [projectId],
        )
      }
      await connection.commit()
    } catch (error: unknown) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }

    const project = await this.loadProject(projectId)
    if (!project) throw new Error(`Project disappeared after attaching root: ${projectId}`)
    return project
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

  async recoverTurn(
    sessionId: string,
    turnId: string,
    interruptedToolError: string,
  ): Promise<void> {
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      await lockSession(connection, sessionId)
      const [turns] = await connection.execute<RowDataPacket[]>(
        `SELECT id FROM agent_turns
         WHERE id = ? AND session_id = ? AND status IN ('running', 'failed')
         FOR UPDATE`,
        [turnId, sessionId],
      )
      if (turns.length !== 1) throw new Error(`Turn ${turnId} is not recoverable`)

      await connection.execute(
        `UPDATE agent_model_attempts AS a
         INNER JOIN agent_model_invocations AS i ON i.id = a.invocation_id
         SET a.status = 'failed', a.error_name = 'InterruptedExecution',
             a.error_message = ?, a.completed_at = CURRENT_TIMESTAMP(6)
         WHERE i.turn_id = ? AND a.status = 'running'`,
        [interruptedToolError, turnId],
      )
      await connection.execute(
        `UPDATE agent_model_invocations
         SET status = 'failed', error_name = 'InterruptedExecution', error_message = ?,
             completed_at = CURRENT_TIMESTAMP(6)
         WHERE turn_id = ? AND status = 'running'`,
        [interruptedToolError, turnId],
      )
      await connection.execute(
        `UPDATE agent_tool_calls AS c
         INNER JOIN agent_steps AS s ON s.id = c.step_id
         SET c.status = 'failed', c.error_message = ?, c.completed_at = CURRENT_TIMESTAMP(6)
         WHERE s.turn_id = ? AND c.status = 'running'`,
        [interruptedToolError, turnId],
      )
      await connection.execute(
        `UPDATE agent_steps AS s
         SET s.status = 'completed', s.completed_at = CURRENT_TIMESTAMP(6)
         WHERE s.turn_id = ? AND s.output_kind = 'tool-call' AND s.status = 'running'
           AND NOT EXISTS (
             SELECT 1 FROM agent_tool_calls AS c
             WHERE c.step_id = s.id AND c.status = 'running'
           )`,
        [turnId],
      )
      await connection.execute(
        `UPDATE agent_turns
         SET status = 'running', error_message = NULL, completed_at = NULL
         WHERE id = ? AND session_id = ?`,
        [turnId, sessionId],
      )
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
  id: string
  turn_id: string
  step_number: number
  status: string
  output_kind: string
  assistant_content: string | null
}

interface ToolCallRow extends RowDataPacket {
  step_id: string
  call_index: number
  status: string
  tool_call_id: string
  tool_name: string
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
    throw new Error('A project cannot contain duplicate project roots')
  }
  if (roots.some(root => root.path.length === 0)) {
    throw new Error('A project root path must not be empty')
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
  if (version > 5) throw new Error(`Database schema version ${version} is newer than supported version 5`)

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

  if (version < 3) {
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS agent_tool_calls (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        step_id BIGINT UNSIGNED NOT NULL,
        call_index INT UNSIGNED NOT NULL,
        status VARCHAR(16) NOT NULL,
        tool_call_id VARCHAR(255) NOT NULL,
        tool_name VARCHAR(255) NOT NULL,
        tool_arguments JSON NOT NULL,
        tool_result LONGTEXT NULL,
        error_message TEXT NULL,
        started_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        completed_at DATETIME(6) NULL,
        UNIQUE KEY uq_agent_tool_calls_step_index (step_id, call_index),
        UNIQUE KEY uq_agent_tool_calls_step_call (step_id, tool_call_id),
        CONSTRAINT fk_agent_tool_calls_step FOREIGN KEY (step_id)
          REFERENCES agent_steps (id) ON DELETE CASCADE,
        CONSTRAINT chk_agent_tool_calls_status
          CHECK (status IN ('running', 'completed', 'failed'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `)
    await pool.execute(`
      INSERT IGNORE INTO agent_tool_calls
        (step_id, call_index, status, tool_call_id, tool_name, tool_arguments,
         tool_result, error_message, started_at, completed_at)
      SELECT id, 0, status, tool_call_id, tool_name, tool_arguments,
             tool_result, error_message, started_at, completed_at
      FROM agent_steps
      WHERE output_kind = 'tool-call'
        AND tool_call_id IS NOT NULL
        AND tool_name IS NOT NULL
        AND tool_arguments IS NOT NULL
    `)
    await pool.execute(`
      UPDATE agent_steps
      SET status = 'completed'
      WHERE output_kind = 'tool-call' AND status = 'failed'
    `)
    await pool.execute('INSERT IGNORE INTO agent_schema_migrations (version) VALUES (3)')
  }

  if (version < 4) {
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS agent_model_invocations (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        turn_id VARCHAR(36) NOT NULL,
        step_number INT UNSIGNED NOT NULL,
        status VARCHAR(16) NOT NULL,
        provider_name VARCHAR(255) NULL,
        model_name VARCHAR(255) NULL,
        protocol_name VARCHAR(64) NULL,
        request_timeout_ms INT UNSIGNED NULL,
        max_retries INT UNSIGNED NULL,
        message_count INT UNSIGNED NOT NULL,
        tool_count INT UNSIGNED NOT NULL,
        input_chars BIGINT UNSIGNED NOT NULL,
        output_kind VARCHAR(16) NULL,
        output_chars BIGINT UNSIGNED NULL,
        reasoning_chars BIGINT UNSIGNED NULL,
        tool_call_count INT UNSIGNED NULL,
        finish_reason VARCHAR(64) NULL,
        provider_request_id VARCHAR(255) NULL,
        input_tokens BIGINT UNSIGNED NULL,
        output_tokens BIGINT UNSIGNED NULL,
        total_tokens BIGINT UNSIGNED NULL,
        cached_input_tokens BIGINT UNSIGNED NULL,
        reasoning_tokens BIGINT UNSIGNED NULL,
        error_name VARCHAR(255) NULL,
        error_message TEXT NULL,
        started_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        completed_at DATETIME(6) NULL,
        UNIQUE KEY uq_agent_model_invocations_turn_step (turn_id, step_number),
        KEY idx_agent_model_invocations_turn_status (turn_id, status),
        CONSTRAINT fk_agent_model_invocations_turn FOREIGN KEY (turn_id)
          REFERENCES agent_turns (id) ON DELETE CASCADE,
        CONSTRAINT chk_agent_model_invocations_status
          CHECK (status IN ('running', 'completed', 'failed')),
        CONSTRAINT chk_agent_model_invocations_kind
          CHECK (output_kind IS NULL OR output_kind IN ('final', 'tool-calls'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `)
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS agent_model_attempts (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        invocation_id BIGINT UNSIGNED NOT NULL,
        attempt_number INT UNSIGNED NOT NULL,
        status VARCHAR(16) NOT NULL,
        http_status SMALLINT UNSIGNED NULL,
        provider_request_id VARCHAR(255) NULL,
        error_name VARCHAR(255) NULL,
        error_message TEXT NULL,
        started_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        completed_at DATETIME(6) NULL,
        UNIQUE KEY uq_agent_model_attempts_invocation_number (invocation_id, attempt_number),
        CONSTRAINT fk_agent_model_attempts_invocation FOREIGN KEY (invocation_id)
          REFERENCES agent_model_invocations (id) ON DELETE CASCADE,
        CONSTRAINT chk_agent_model_attempts_status
          CHECK (status IN ('running', 'completed', 'failed'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `)
    await pool.execute('INSERT IGNORE INTO agent_schema_migrations (version) VALUES (4)')
  }

  if (version < 5) {
    await pool.execute(`
      ALTER TABLE agent_model_invocations
        DROP INDEX uq_agent_model_invocations_turn_step,
        ADD COLUMN invocation_number INT UNSIGNED NOT NULL DEFAULT 1 AFTER step_number,
        ADD COLUMN max_tokens INT UNSIGNED NULL AFTER input_chars,
        ADD UNIQUE KEY uq_agent_model_invocations_turn_step_number
          (turn_id, step_number, invocation_number)
    `)
    await pool.execute('INSERT IGNORE INTO agent_schema_migrations (version) VALUES (5)')
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
    case 'model.invocation-started': {
      await requireRunningTurn(connection, sessionId, record.turnId)
      const [numbers] = await connection.execute<(RowDataPacket & { next_number: number })[]>(
        `SELECT COALESCE(MAX(invocation_number), 0) + 1 AS next_number
         FROM agent_model_invocations WHERE turn_id = ? AND step_number = ?`,
        [record.turnId, record.step],
      )
      const invocationNumber = numbers[0]?.next_number
      if (invocationNumber === undefined) {
        throw new Error(`Cannot allocate model invocation number for step ${record.step}`)
      }
      await connection.execute(
        `INSERT INTO agent_model_invocations
           (turn_id, step_number, invocation_number, status, provider_name, model_name,
            protocol_name, request_timeout_ms, max_retries, message_count, tool_count,
            input_chars, max_tokens)
         VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          record.turnId,
          record.step,
          invocationNumber,
          record.descriptor?.provider ?? null,
          record.descriptor?.model ?? null,
          record.descriptor?.protocol ?? null,
          record.descriptor?.requestTimeoutMs ?? null,
          record.descriptor?.maxRetries ?? null,
          record.messageCount,
          record.toolCount,
          record.inputChars,
          record.maxTokens ?? null,
        ],
      )
      return
    }
    case 'model.attempt': {
      const invocationId = await requireRunningModelInvocation(
        connection,
        record.turnId,
        record.step,
      )
      if (record.event.type === 'started') {
        await connection.execute(
          `INSERT INTO agent_model_attempts
             (invocation_id, attempt_number, status)
           VALUES (?, ?, 'running')`,
          [invocationId, record.event.attempt],
        )
        return
      }
      const status = record.event.type === 'completed' ? 'completed' : 'failed'
      const [result] = await connection.execute<ResultSetHeader>(
        `UPDATE agent_model_attempts
         SET status = ?, http_status = ?, provider_request_id = ?,
             error_name = ?, error_message = ?, completed_at = CURRENT_TIMESTAMP(6)
         WHERE invocation_id = ? AND attempt_number = ? AND status = 'running'`,
        [
          status,
          record.event.httpStatus ?? null,
          record.event.providerRequestId ?? null,
          record.event.type === 'failed' ? record.event.errorName : null,
          record.event.type === 'failed' ? record.event.errorMessage : null,
          invocationId,
          record.event.attempt,
        ],
      )
      requireChanged(result, `Cannot ${status} model attempt ${record.event.attempt}`)
      return
    }
    case 'model.invocation-completed': {
      const usage = record.metadata?.usage
      const [result] = await connection.execute<ResultSetHeader>(
        `UPDATE agent_model_invocations
         SET status = 'completed', output_kind = ?, output_chars = ?, reasoning_chars = ?,
             tool_call_count = ?, finish_reason = ?, provider_request_id = ?,
             input_tokens = ?, output_tokens = ?, total_tokens = ?,
             cached_input_tokens = ?, reasoning_tokens = ?, completed_at = CURRENT_TIMESTAMP(6)
         WHERE turn_id = ? AND step_number = ? AND status = 'running'`,
        [
          record.outputKind,
          record.outputChars,
          record.reasoningChars,
          record.toolCallCount,
          record.metadata?.finishReason ?? null,
          record.metadata?.providerRequestId ?? null,
          usage?.inputTokens ?? null,
          usage?.outputTokens ?? null,
          usage?.totalTokens ?? null,
          usage?.cachedInputTokens ?? null,
          usage?.reasoningTokens ?? null,
          record.turnId,
          record.step,
        ],
      )
      requireChanged(result, `Cannot complete model invocation for step ${record.step}`)
      return
    }
    case 'model.invocation-failed': {
      const [result] = await connection.execute<ResultSetHeader>(
        `UPDATE agent_model_invocations
         SET status = 'failed', error_name = ?, error_message = ?,
             completed_at = CURRENT_TIMESTAMP(6)
         WHERE turn_id = ? AND step_number = ? AND status = 'running'`,
        [record.errorName, record.error, record.turnId, record.step],
      )
      requireChanged(result, `Cannot fail model invocation for step ${record.step}`)
      return
    }
    case 'step.tools-called': {
      await requireRunningTurn(connection, sessionId, record.turnId)
      if (record.calls.length === 0) throw new Error('A tool Step must contain at least one call')
      const [step] = await connection.execute<ResultSetHeader>(
        `INSERT INTO agent_steps
           (turn_id, step_number, status, output_kind)
         VALUES (?, ?, 'running', 'tool-call')`,
        [record.turnId, record.step],
      )
      for (const [callIndex, call] of record.calls.entries()) {
        await connection.execute(
          `INSERT INTO agent_tool_calls
             (step_id, call_index, status, tool_call_id, tool_name, tool_arguments)
           VALUES (?, ?, 'running', ?, ?, ?)`,
          [step.insertId, callIndex, call.id, call.name, JSON.stringify(call.arguments ?? null)],
        )
      }
      return
    }
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

async function requireRunningModelInvocation(
  connection: PoolConnection,
  turnId: string,
  step: number,
): Promise<number> {
  const [rows] = await connection.execute<(RowDataPacket & { id: number })[]>(
    `SELECT id FROM agent_model_invocations
     WHERE turn_id = ? AND step_number = ? AND status = 'running'`,
    [turnId, step],
  )
  const id = rows[0]?.id
  if (id === undefined) throw new Error(`Model invocation for step ${step} is not running`)
  return id
}

async function updateToolStep(
  connection: PoolConnection,
  record: Extract<SessionRecord, { type: 'step.tool-completed' | 'step.tool-failed' }>,
  status: 'completed' | 'failed',
): Promise<void> {
  const value = record.type === 'step.tool-completed' ? record.result : record.error
  const column = record.type === 'step.tool-completed' ? 'tool_result' : 'error_message'
  const [result] = await connection.execute<ResultSetHeader>(
    `UPDATE agent_tool_calls AS c
     INNER JOIN agent_steps AS s ON s.id = c.step_id
     SET c.status = ?, c.${column} = ?, c.completed_at = CURRENT_TIMESTAMP(6)
     WHERE s.turn_id = ? AND s.step_number = ? AND c.tool_call_id = ?
       AND s.output_kind = 'tool-call' AND c.status = 'running'`,
    [status, value, record.turnId, record.step, record.toolCallId],
  )
  requireChanged(
    result,
    `Cannot ${status === 'completed' ? 'complete' : 'fail'} tool call ${record.toolCallId}`,
  )
  await connection.execute(
    `UPDATE agent_steps AS s
     SET s.status = 'completed', s.completed_at = CURRENT_TIMESTAMP(6)
     WHERE s.turn_id = ? AND s.step_number = ? AND s.status = 'running'
       AND NOT EXISTS (
         SELECT 1 FROM agent_tool_calls AS c
         WHERE c.step_id = s.id AND c.status = 'running'
       )`,
    [record.turnId, record.step],
  )
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

function toStep(row: StepRow, executions: readonly AgentToolExecution[]): AgentStep {
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
  if (executions.length === 0) throw new Error(`Tool step ${row.step_number} has no calls`)
  return {
    stepNumber: row.step_number,
    status,
    output: { kind: 'tool-calls', executions },
  }
}

function toToolExecution(row: ToolCallRow): AgentToolExecution {
  return {
    call: {
      id: row.tool_call_id,
      name: row.tool_name,
      arguments: parseJson(row.tool_arguments),
    },
    status: readToolExecutionStatus(row.status),
    ...(row.tool_result === null ? {} : { result: row.tool_result }),
    ...(row.error_message === null ? {} : { error: row.error_message }),
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

function readToolExecutionStatus(value: string): 'running' | 'completed' | 'failed' {
  if (value === 'running' || value === 'completed' || value === 'failed') return value
  throw new Error(`Unknown tool execution status: ${value}`)
}
