-- CreateTable
CREATE TABLE "task_executions" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "taskType" VARCHAR(16) NOT NULL,
    "platform" VARCHAR(32) NOT NULL,
    "userId" INTEGER,
    "windowId" VARCHAR(128) NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'running',
    "currentPhase" VARCHAR(64),
    "phaseIndex" INTEGER,
    "totalPhases" INTEGER,
    "progressPercent" INTEGER,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "duration_ms" INTEGER,
    "error_message" TEXT,
    "is_debug_mode" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_execution_steps" (
    "id" TEXT NOT NULL,
    "execution_id" TEXT NOT NULL,
    "phase" VARCHAR(64) NOT NULL,
    "step_index" INTEGER NOT NULL,
    "label" VARCHAR(128) NOT NULL,
    "status" VARCHAR(16) NOT NULL,
    "duration_ms" INTEGER,
    "selector_tries" JSONB,
    "mouse_action" VARCHAR(128),
    "extra" JSONB,
    "snapshot_path" VARCHAR(512),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_execution_steps_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_task_exec_type_created" ON "task_executions"("taskType", "created_at");

-- CreateIndex
CREATE INDEX "idx_task_exec_status_created" ON "task_executions"("status", "created_at");

-- CreateIndex
CREATE INDEX "idx_task_exec_user_created" ON "task_executions"("userId", "created_at");

-- CreateIndex
CREATE INDEX "idx_task_step_exec_index" ON "task_execution_steps"("execution_id", "step_index");

-- AddForeignKey
ALTER TABLE "task_execution_steps" ADD CONSTRAINT "task_execution_steps_execution_id_fkey" FOREIGN KEY ("execution_id") REFERENCES "task_executions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
