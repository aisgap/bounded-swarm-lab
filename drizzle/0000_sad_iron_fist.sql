CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`run_id` text,
	`step_id` text,
	`event_type` text NOT NULL,
	`safe_metadata_json` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_run_created_idx` ON `audit_events` (`run_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `experiment_budget` (
	`id` text PRIMARY KEY NOT NULL,
	`authorized_microusd` integer NOT NULL,
	`start_threshold_microusd` integer NOT NULL,
	`outstanding_microusd` integer DEFAULT 0 NOT NULL,
	`reconciled_microusd` integer DEFAULT 0 NOT NULL,
	`active_step_id` text,
	`lease_expires_at` integer,
	`version` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `records` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`step_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`author` text NOT NULL,
	`content_json` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`step_id`) REFERENCES `steps`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `records_run_sequence_unique` ON `records` (`run_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`mode` text NOT NULL,
	`objective` text NOT NULL,
	`acceptance_criteria` text NOT NULL,
	`model` text NOT NULL,
	`price_version` text NOT NULL,
	`status` text NOT NULL,
	`current_agent` text NOT NULL,
	`call_count` integer DEFAULT 0 NOT NULL,
	`handoff_count` integer DEFAULT 0 NOT NULL,
	`researcher_visits` integer DEFAULT 0 NOT NULL,
	`architect_visits` integer DEFAULT 0 NOT NULL,
	`coder_visits` integer DEFAULT 0 NOT NULL,
	`reviewer_visits` integer DEFAULT 0 NOT NULL,
	`max_calls` integer NOT NULL,
	`max_handoffs` integer NOT NULL,
	`max_visits_per_agent` integer NOT NULL,
	`token_budget` integer NOT NULL,
	`max_input_tokens` integer NOT NULL,
	`max_output_tokens` integer NOT NULL,
	`run_spend_cap_microusd` integer NOT NULL,
	`reserved_tokens` integer DEFAULT 0 NOT NULL,
	`used_tokens` integer DEFAULT 0 NOT NULL,
	`outstanding_microusd` integer DEFAULT 0 NOT NULL,
	`reconciled_microusd` integer DEFAULT 0 NOT NULL,
	`active_step_id` text,
	`stop_requested` integer DEFAULT false NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`deadline_at` integer NOT NULL,
	`last_error_code` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runs_user_idempotency_unique` ON `runs` (`user_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `runs_user_created_idx` ON `runs` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `steps` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`user_id` text NOT NULL,
	`step_number` integer NOT NULL,
	`idempotency_key` text NOT NULL,
	`agent` text NOT NULL,
	`status` text NOT NULL,
	`next_agent` text,
	`client_request_id` text NOT NULL,
	`provider_request_id` text,
	`provider_response_id` text,
	`reserved_input_tokens` integer NOT NULL,
	`reserved_output_tokens` integer NOT NULL,
	`reserved_microusd` integer NOT NULL,
	`input_tokens` integer,
	`cached_input_tokens` integer,
	`cache_write_tokens` integer,
	`output_tokens` integer,
	`reasoning_tokens` integer,
	`total_tokens` integer,
	`actual_microusd` integer,
	`safe_error_code` text,
	`retry_after_seconds` integer,
	`started_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `steps_run_number_unique` ON `steps` (`run_id`,`step_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `steps_run_idempotency_unique` ON `steps` (`run_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `steps_run_started_idx` ON `steps` (`run_id`,`started_at`);--> statement-breakpoint
INSERT INTO `experiment_budget` (
	`id`, `authorized_microusd`, `start_threshold_microusd`,
	`outstanding_microusd`, `reconciled_microusd`, `active_step_id`,
	`lease_expires_at`, `version`, `updated_at`
) VALUES (
	'initial-openai-experiments-v1', 0, 0,
	0, 0, NULL, NULL, 0, 0
);
