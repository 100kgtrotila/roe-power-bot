CREATE TABLE `deliveries` (
	`key` text PRIMARY KEY NOT NULL,
	`telegram_id` text NOT NULL,
	`type` text NOT NULL,
	`due_at` integer NOT NULL,
	`payload` text NOT NULL,
	`revision` integer NOT NULL,
	`status` text NOT NULL,
	`part_cursor` integer DEFAULT 0 NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`telegram_id`) REFERENCES `subscribers`(`telegram_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `deliveries_due` ON `deliveries` (`status`,`due_at`);--> statement-breakpoint
CREATE TABLE `leases` (
	`resource` text PRIMARY KEY NOT NULL,
	`claim_token` text NOT NULL,
	`expiry` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `leases_expiry` ON `leases` (`expiry`);--> statement-breakpoint
CREATE TABLE `notification_state` (
	`telegram_id` text NOT NULL,
	`date` text NOT NULL,
	`baseline` text NOT NULL,
	PRIMARY KEY(`telegram_id`, `date`),
	FOREIGN KEY (`telegram_id`) REFERENCES `subscribers`(`telegram_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `operations` (
	`key` text PRIMARY KEY NOT NULL,
	`claim_token` text NOT NULL,
	`expiry` integer NOT NULL,
	`completed_at` integer
);
--> statement-breakpoint
CREATE INDEX `operations_expiry` ON `operations` (`expiry`);--> statement-breakpoint
CREATE TABLE `reminder_receipts` (
	`telegram_id` text NOT NULL,
	`date` text NOT NULL,
	`queue` text NOT NULL,
	`start` integer NOT NULL,
	`generation` text NOT NULL,
	PRIMARY KEY(`telegram_id`, `date`, `queue`, `start`, `generation`),
	FOREIGN KEY (`telegram_id`) REFERENCES `subscribers`(`telegram_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `schedule_snapshots` (
	`id` integer PRIMARY KEY NOT NULL,
	`snapshot` text NOT NULL,
	CONSTRAINT "snapshot_singleton" CHECK("schedule_snapshots"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE `source_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`last_attempt_at` integer,
	`last_success_at` integer,
	`next_attempt_at` integer NOT NULL,
	`failure_count` integer NOT NULL,
	`unavailable` integer NOT NULL,
	CONSTRAINT "source_singleton" CHECK("source_state"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE `subscribers` (
	`telegram_id` text PRIMARY KEY NOT NULL,
	`selection` text,
	`updates_enabled` integer NOT NULL,
	`reminders_enabled` integer NOT NULL,
	`reminder_minutes` integer NOT NULL,
	`revision` integer NOT NULL,
	CONSTRAINT "selection_valid" CHECK("subscribers"."selection" IS NULL OR "subscribers"."selection" IN ('all','1.1','1.2','2.1','2.2','3.1','3.2','4.1','4.2','5.1','5.2','6.1','6.2')),
	CONSTRAINT "reminder_interval_valid" CHECK("subscribers"."reminder_minutes" IN (15,30,60)),
	CONSTRAINT "revision_valid" CHECK("subscribers"."revision" >= 1)
);
--> statement-breakpoint
CREATE INDEX `subscribers_active` ON `subscribers` (`updates_enabled`,`reminders_enabled`);