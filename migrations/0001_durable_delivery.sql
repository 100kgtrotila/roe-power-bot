ALTER TABLE `deliveries` ADD `expires_at` integer DEFAULT 9007199254740991 NOT NULL;--> statement-breakpoint
ALTER TABLE `deliveries` ADD `claim_token` text;--> statement-breakpoint
ALTER TABLE `deliveries` ADD `claim_expiry` integer;