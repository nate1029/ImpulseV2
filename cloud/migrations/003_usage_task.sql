-- Which task (one user message to the agent, with every model call it took)
-- a request belongs to, from the app's x-impulse-task header: cost per task
-- is then one query, which is how prompt and tool changes get measured.

alter table usage_event add column if not exists task_id text;
create index if not exists usage_event_task on usage_event (task_id) where task_id is not null;
