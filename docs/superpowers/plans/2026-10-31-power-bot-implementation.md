# ROE Power Bot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Execution method is chosen by the user after reviewing this plan.

**Goal:** реалізувати приватний бот графіків Рівнеобленерго з вибором підчерги,
стійкими оновленнями, необов'язковими нагадуваннями та українським гайдом хостингу.

**Architecture:** наявний Worker приймає Telegram webhook; grammY обробляє команди.
Один щохвилинний cron запускає нагадування, а джерело читає не частіше разу на
5 хвилин. D1 зберігає підписки, останні коректні дані, контроль виконання й доставки;
чисті функції визначають зміни та повідомлення окремо від HTTP і бази.

**Tech Stack:** TypeScript strict/ESM, grammY, Cloudflare Workers/D1, Drizzle,
pnpm 10.33.0, Vitest, Biome; HTML-парсер додається лише для розбору реальної таблиці.

**Spec:** [погоджений дизайн](../specs/2026-10-31-power-bot-design.md).

**Стан 31.10.2026:** програмні задачі 1–8 реалізовано; 117 тестів, typecheck,
lint, dry-run build та локальний /health пройшли. Окремий гайд і результати:
`../../deployment.md`, `../../verification.md`. Пункти про реальний deploy,
webhook, вимірювання CPU/D1 та перевірку фактичних джерельних маркерів залишені
для першого хмарного запуску; локальні результати їх не підтверджують.

## Global Constraints

- Працювати в `D:/Projects/roe-power-bot`; перед виконанням повторно перевірити актуальний стан файлів.
- Використовувати pnpm та наявні scripts; не послаблювати TypeScript, не вводити `any` чи небезпечні casts.
- Час джерела трактувати в `Europe/Kyiv`, з урахуванням переходу часу.
- Вибір — одна власна підчерга 1.1–6.2 або режим «Усі підчерги».
- Нагадування можна увімкнути за 15, 30 або 60 хвилин; початково вимкнені.
- Оновлення й нагадування мають незалежні перемикачі, діють цілодобово.
- `/stop` лише відкриває меню; до вибору користувача нічого не вимикається.
- Ручний перегляд використовує збережені дані; немає запиту до сайту на кожного користувача.
- Початкове «Очікується» мовчить; перехід з опублікованих годин до очікування повідомляється один раз.
- Збій джерела не скасовує графік; нагадування тривають із попередженням.
- Жодного реального токена, Telegram-запиту чи сайту в автоматичних тестах.
- Не комітити, не пушити, не створювати хмарні ресурси й не деплоїти без окремого запиту.

## Review Focus

1. Неповна таблиця не означає скасування: зберегти дані й позначити збій (задачі 1, 3).
2. Одночасні webhook/cron та повторні updates не відновлюють зупинену підписку й не дублюють розсилку (2, 5, 6, 7).
3. Опівніч і перехід літнього часу не змішують дати та не створюють минулих нагадувань (1, 4, 6).
4. Частковий успіх довгої розсилки та 429 не гублять дані й не повторюють уже підтверджені частини (5, 7).
5. Графік опубліковано запізно або перенесено: одна потрібна відповідь, без негайного дублю нагадування (4, 6).

## Файли й межі модулів

| Файли                                                                                | Відповідальність                                       |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| `src/schedule/model.ts`, `time.ts`, `parser.ts`, `source.ts`                         | Типи, київський час, HTML і завантаження               |
| `src/db/schema.ts`, `client.ts`, `subscriptions.ts`, `schedule.ts`, `operations.ts`  | Конкретні D1-операції, без універсального Repository   |
| `src/notifications/changes.ts`, `reminders.ts`, `messages.ts`, `delivery.ts`         | Чисті правила й транспорт доставки                     |
| `src/bot.ts`, `src/bot/commands.ts`, `keyboards.ts`, `callbacks.ts`, `src/config.ts` | Фабрика, Telegram UX, перевірка конфігурації           |
| `src/scheduled.ts`, `src/index.ts`                                                   | Збирання компонентів і точки входу                     |
| `migrations/`, `drizzle.config.ts`, `wrangler.jsonc`                                 | Схема й міграції без реальних ідентифікаторів/секретів |
| `tests/unit/`, `tests/integration/`, `tests/fixtures/`                               | Чисті сценарії та інтеграція з локальною D1            |
| `README.md`, `docs/deployment.md`, `scripts/telegram-webhook.mjs`                    | Запуск, деплой, безпечне налаштування webhook          |

Це один продукт із послідовними залежностями; не розробляти частини як незалежні
проєкти. Наявні `tests/bot.test.ts` та `tests/worker.test.ts` зберегти й адаптувати
в задачах 2 і 6, не втрачати перевірки HTTP та приватних чатів.

### Task 1: Предметна модель, час і парсер

**Files:** create `src/schedule/model.ts`, `time.ts`, `parser.ts`,
`tests/unit/parser.test.ts`, `time.test.ts`, `tests/fixtures/disconnections/README.md`
і HTML-фікстури; modify `package.json`, `pnpm-lock.yaml` лише при додаванні парсера.

**Interfaces:**
- `QueueId` — підчерги 1.1–6.2; `Selection = QueueId | "all"`.
- `OutageInterval = { startMinute: number; endMinute: number }`, 0–1440,
  кінець строго після початку; 24:00 допустиме тільки як кінець.
- `QueueSchedule` — union з `status: "pending" | "none" | "scheduled"`;
  інтервали є тільки для `scheduled`.
- `DaySchedule = { date: string; queues: Record<QueueId, QueueSchedule> }`, ISO-дата.
- `ScheduleSnapshot = { days: DaySchedule[]; checkedAt: number }`, час у UTC milliseconds.
- `parseSchedule(html: string, checkedAt: number): ScheduleSnapshot` кидає
  `ScheduleParseError`, якщо таблиця неповна/неоднозначна.
- `getKyivDates(now: number): { today: string; tomorrow: string }`;
  `getOutageStart(date: string, startMinute: number): number | null`.

- [ ] Один раз вручну оглянути фактичний HTML джерела й зберегти релевантну таблицю
  з датою отримання. У README фікстур відділити реальний HTML від синтетичних
  варіантів; не називати вигадані значення спостереженими на сайті.
- [ ] За реальною структурою вибрати легкий Workers-сумісний HTML-парсер.
  З'ясувати фактичні маркери відсутності відключень; якщо їх не спостережено,
  невідомий текст відхиляти, а не вгадувати значення.
- [ ] Написати RED-тести: 12 підчерг/дві дати; «Очікується»; години з `<br>`;
  переставлені заголовки; відсутня/дубльована клітинка; неправильна дата/години;
  явне `none` тільки для перевіреного маркера. Literal-очікування — конкретні
  дати, підчерги та інтервали з фікстури, не результат іншого production helper.
- [ ] Запустити `pnpm test tests/unit/parser.test.ts tests/unit/time.test.ts` і
  підтвердити очікуваний RED. Додати тести київської опівночі, 24:00 й переходів
  часу; неоднозначний/неіснуючий локальний початок повертає `null`, не вгадується.
- [ ] Реалізувати типи, нормалізацію та перетворення часу. Використовувати IANA
  timezone, без зашитих UTC+2/UTC+3; якщо runtime не має потрібного API, додати
  одну спеціалізовану timezone-бібліотеку після перевірки сумісності й розміру.
- [ ] Повторити команду; очікується PASS. Порожній HTML і неповна таблиця мають
  давати помилку, ніколи `none`. Не починати live polling у цій задачі.

### Task 2: D1, міграції та контроль стану

**Files:** create `src/db/{schema,client,subscriptions,schedule,operations}.ts`,
`drizzle.config.ts`, `migrations/0000_initial.sql`, `tests/integration/storage.test.ts`,
`tests/integration/setup.ts`, `vitest.workers.config.ts`; modify `package.json`,
`pnpm-lock.yaml`, `tsconfig.json`, `vitest.config.ts`, `wrangler.jsonc`.

**Interfaces:**
- `Subscriber = { telegramId: string; selection: Selection | null; updatesEnabled: boolean;
  remindersEnabled: boolean; reminderMinutes: 15 | 30 | 60; revision: number }`.
- `createDb(binding: D1Database)` — конкретний Drizzle D1 client; `AppDb` — його тип.
- `getSubscriber(db: AppDb, telegramId: string): Promise<Subscriber | null>`;
  `saveSubscriber(db: AppDb, input: Subscriber, expectedRevision: number): Promise<boolean>`.
- `loadSnapshot(db: AppDb): Promise<ScheduleSnapshot | null>`;
  `saveSnapshot(db: AppDb, snapshot: ScheduleSnapshot): Promise<void>`.
- `SourceState = { lastAttemptAt: number | null; lastSuccessAt: number | null;
  nextAttemptAt: number; failureCount: number; unavailable: boolean }`;
  `loadSourceState(db): Promise<SourceState>`; `saveSourceState(db, state): Promise<void>`.
- `claimOperation(db: AppDb, key: string, now: number, leaseMs: number): Promise<string | null>`;
  `completeOperation(db: AppDb, key: string, claimToken: string): Promise<boolean>`.
- Для повторюваних задач окремий reusable lease:
  `claimLease(db: AppDb, resource: string, now: number, leaseMs: number): Promise<string | null>`;
  `releaseLease(db: AppDb, resource: string, claimToken: string): Promise<void>`.
  `completeOperation` зберігає завершення унікальної операції, а releaseLease
  дозволяє наступний цикл; ці два поняття не змішувати.

- [ ] Додати стабільні сумісні `drizzle-orm`, `drizzle-kit` і
  `@cloudflare/vitest-plugin`. Перевірити peerDependencies перед встановленням;
  зберегти Vitest 5, якщо підтримується, і не міняти major без доведеної потреби.
  Unit-тести лишити в Node; integration — в окремій Workers-конфігурації.
- [ ] Написати RED-тести справжньої локальної D1: нова підписка, збереження після
  повторного створення client, CAS-конфлікт revision, два claim одного key,
  відновлення після expiry, старий claimToken не може завершити нову операцію.
- [ ] Запустити `pnpm test --config vitest.workers.config.ts tests/integration/storage.test.ts`.
  Підтвердити RED, потім створити Drizzle-схему й міграцію через drizzle-kit.
- [ ] Таблиці: `subscribers` (telegramId PK, CHECK для selection/interval),
  `schedule_snapshots` (один поточний snapshot), `source_state` (один запис),
  `operations` (key PK, claimToken, expiry, completedAt),
  `leases` (resource PK, claimToken, expiry), `deliveries` (key PK,
  користувач, тип, dueAt, payload, revision, status, part cursor, attempts),
  `notification_state` (користувач + дата, останній підтверджений вибір/вміст),
  `reminder_receipts` (користувач + дата + підчерга + початок + generation).
  Індекси — на активні підписки, due deliveries та expiry; не зберігати профілі/імена.
- [ ] Налаштувати `DB` і `migrations_dir` для локальних тестів без створення remote D1.
  Міграції застосовуються у setup на ізольовану тестову базу.
  Атомарні групи записів — через D1 batch, не transaction API іншої SQLite-бази.
- [ ] Реалізувати функції, підтвердити PASS і `pnpm run typecheck`.
  Додати scripts `test:integration`, `db:generate`, `db:migrate:local`;
  фінальний `pnpm test` має запускати і unit, і integration, без саморекурсії scripts.

### Task 3: Спільне завантаження та збереження останнього графіка

**Files:** create `src/schedule/source.ts`, `tests/unit/source.test.ts`,
`tests/integration/source-refresh.test.ts`; modify `src/db/schedule.ts`.

**Interfaces:** consumes Task 1/2;
`refreshScheduleIfDue(db: AppDb, now: number, fetcher: typeof fetch): Promise<void>`.
HTTP URL — один source constant; HTTP, clock і база не приховані в глобальному стані.

- [ ] RED-тести: 20 підписок дають один HTTP fetch; повтор до 5 хвилин не дає нового;
  одночасні refresh — один власник; після рестарту nextAttemptAt зберігається.
  429 з Retry-After seconds/HTTP-date, 503, timeout, завеликий stream,
  часткова таблиця й невірний content-type не затирають snapshot.
- [ ] Запустити відповідні unit/integration тести, підтвердити RED.
- [ ] Реалізувати timeout 10 секунд, максимум HTML 2 MiB зі stream-лімітом,
  звичайний інтервал 300 секунд. Після збоїв backoff 5/10/20/40/60 хвилин,
  server Retry-After може збільшувати паузу; успіх скидає failureCount.
  Reusable lease ресурсу `source-refresh` має покривати timeout і запис;
  прострочений власник не записує новий стан. Перевірка ownership і зміна стану
  атомарні в D1; перевірка token окремим SELECT перед незахищеним UPDATE недостатня.
- [ ] Зберігати snapshot і успіх узгоджено. Помилка виставляє unavailable,
  зберігає lastSuccessAt і старий snapshot; не створює користувацьке повідомлення.
- [ ] Повторити тести до PASS. Перевірити відсутність HTTP у ручних командах пізніше
  інтеграційним тестом Task 6, а не лише структурою модулів.

### Task 4: Чисті правила змін, нагадувань і текстів

**Files:** create `src/notifications/{changes,reminders,messages}.ts`,
`tests/unit/{changes,reminders,messages}.test.ts`.

**Interfaces:**
- `ScheduleView` — проєкція snapshot на selection та київські сьогодні/завтра.
  `getScheduleView(snapshot: ScheduleSnapshot, selection: Selection, now: number): ScheduleView`.
- `NotificationState` — останній успішно показаний/надісланий власний view для дати.
- `planChanges(previous: NotificationState | null, current: ScheduleView): ChangeNotice[]`;
  `ChangeNotice` містить date, повний поточний view та список змінених підчерг/інтервалів.
- `ReminderNotice` містить date, початок UTC, queueIds і відомості про stale.
  `planReminders(subscriber: Subscriber, view: ScheduleView, now: number,
  receipts: ReminderReceipt[]): ReminderNotice[]`.
- `renderSchedule(view: ScheduleView, source: SourceState, changes?: ChangeNotice[]): string[]`;
  `renderReminder(notice: ReminderNotice, now: number): string`.

- [ ] Написати RED-тести переходів: null→pending = 0; pending→години = 1;
  години→ті самі = 0; години→pending = 1; pending→pending = 0;
  години→none = 1; none→none = 0. Інша підчерга/лише updatedAt не створюють змін.
  A→B→A — нове повідомлення, а не вічне придушення за hash.
- [ ] Додати RED-тести: нова дата, сьогодні+завтра, минула дата, повний графік зі
  змінами; вибір all об'єднує повідомлення, pending однієї підчерги не скасовує інші.
- [ ] Тести нагадувань з literal UTC: початок 18:00, інтервал 30 хв → due 17:30;
  один початок у трьох підчергах → одне повідомлення, receipts для трьох.
  Початок уже минув → 0; pending/none → 0; stale години → нагадування з попередженням.
- [ ] Окремо перевірити пізнє оновлення за 10 хвилин при інтервалі 30: один
  графік із відліком та receipt, окреме негайне нагадування = 0.
  Перенесення 16:00→18:00 допускає нове нагадування, зміна лише кінця — ні.
- [ ] Запустити `pnpm test tests/unit/changes.test.ts tests/unit/reminders.test.ts tests/unit/messages.test.ts`,
  побачити RED, реалізувати правила й довести до PASS.
  Тексти — plain text, частини до 4000 символів, без обрізаних інтервалів,
  з датою/перевіркою/джерелом. Для переходів DST не створювати помилковий UTC-start.

### Task 5: Стійка доставка та придушення повторів

**Files:** create `src/notifications/delivery.ts`, `tests/integration/delivery.test.ts`;
modify `src/db/operations.ts`, `src/db/schema.ts` лише новою міграцією при потребі.

**Interfaces:**
- `DeliveryIntent = { key: string; telegramId: string; kind: "change" | "reminder" | "direct";
  parts: string[]; dueAt: number; subscriberRevision: number; expiresAt: number }`.
- `enqueueDelivery(db: AppDb, intent: DeliveryIntent): Promise<void>`;
  `deliverDue(db: AppDb, api: Api, allowedIds: ReadonlySet<string>, now: number): Promise<void>`.
- `ReminderReceipt = { date: string; queueId: QueueId; startsAt: number; generation: number }`.
  `loadReminderReceipts(db, telegramId): Promise<ReminderReceipt[]>`;
  `loadNotificationState(db, telegramId): Promise<NotificationState | null>`.

- [ ] RED-тести з реальною D1 та fake Telegram HTTP: два enqueue одного key;
  конкурентні deliverDue; restart; збій на другій частині з трьох;
  Telegram 429/403/timeout; старий worker після expiry не завершує чужий claim.
- [ ] Перевірити відключення/removal з allowlist після enqueue: нова спроба не
  надсилає старий intent. Перед кожною частиною перечитувати subscriber revision
  і перемикач відповідного kind. Уже надіслане повідомлення відкликати неможливо.
- [ ] Запустити `pnpm run test:integration -- tests/integration/delivery.test.ts`,
  підтвердити RED; реалізувати claim, part cursor, dueAt, bounded retry без sleep.
  429 відкласти за retry_after, 403 зупиняє автоматичні спроби цього користувача,
  інші тимчасові помилки — відкладена спроба на наступному cron.
- [ ] Cursor оновлюється після підтвердження кожної частини. Baseline змін та
  reminder receipts фіксуються після підтвердження відповідного повідомлення.
  Незавершений застарілий intent скасовується; залишається лише актуальний графік.
  Для пізнього графіка delivery включає і reminder receipt, щоб не було дубля.
- [ ] Унікальний key змін включає послідовність переходу та revision підписки,
  а не лише hash вмісту. Reminder receipts прив'язані до підчерги/дати/початку;
  інтервал і всі підчерги не розмножують уже надіслане нагадування.
- [ ] Довести тести до PASS; явно задокументувати можливий повтор у вікні
  «Telegram прийняв → D1 ще не записав», не заявляти exactly-once.

### Task 6: Кнопки, команди, allowlist і налаштування

**Files:** create `src/config.ts`, `src/bot/{commands,keyboards,callbacks}.ts`,
`tests/unit/config.test.ts`, `tests/integration/bot-flows.test.ts`;
modify `src/bot.ts`, `src/index.ts`, `tests/bot.test.ts`, `tests/worker.test.ts`,
`.dev.vars.example`, `wrangler.jsonc`.

**Interfaces:**
- `parseAllowedIds(value: string | undefined): ReadonlySet<string>` — fail closed;
  `ALLOWED_TELEGRAM_IDS` — comma-separated decimal IDs, без імен/username.
- `BotServices = { db: AppDb; allowedIds: ReadonlySet<string>; now: () => number }`;
  `createBot(token: string, services: BotServices, options?: BotConfig<Context>): Bot`.
- `parseCallback(data: string): BotAction | null`; `BotAction` — union для
  перегляду, selection, інтервалу, незалежних enable/disable і stop-all.

- [ ] RED-тести з реальними grammY routing і D1: невідомий ID/група не змінюють
  даних, callback іншого користувача не застосовується; callback_data валідована,
  answerCallbackQuery викликається до повільної доставки. Старі callback-кнопки
  звіряються з актуальними налаштуваннями, без довіри до вбудованого стану.
- [ ] Перевірити перше налаштування (updates on, reminders off), `/start` повторно
  не скидає стан; один queue/all; зміна queue зберігає reminderMinutes/enable,
  інвалідує старі intents через revision і одразу показує новий view.
- [ ] Тести `/schedule`: сьогодні+завтра; `/all`: весь графік без зміни selection
  та baseline власної підчерги; unavailable: кеш+час+попередження; немає кешу:
  пояснення без вигаданого графіка. У всіх цих тестах кількість source HTTP = 0.
- [ ] Перевірити `/stop` лише відкриває меню; явні дії вимикають updates/reminders
  незалежно або разом. Resume updates одразу надсилає графік, наступний cron
  його не повторює; resume reminders застосовує правило пізнього початку.
- [ ] Повтор того самого update_id не повторює mutation або пряме повідомлення.
  Claim update з retry після збою, успішна обробка завершується після збереження
  intents. Telegram-відповідь може бути доставлена через Task 5 без втрати update.
- [ ] Запустити відповідні тести, побачити RED, реалізувати інтеграцію.
  Меню: «Мій графік», «Усі черги», «Обрати підчергу», «Нагадування»,
  «Керування сповіщеннями», «Допомога»; жодних непрацюючих кнопок.
- [ ] Довести до PASS, зберігши захист `/webhook`, `/health` і безпечні 503;
  оновити приклад env без токенів і реальних ID. Не змінювати AGENTS.md:
  погоджена специфікація вже фіксує уточнену семантику `/stop`.

### Task 7: Щохвилинний цикл і наскрізні сценарії

**Files:** create `src/scheduled.ts`, `tests/integration/scheduled.test.ts`;
modify `src/index.ts`, `wrangler.jsonc`, `src/db/operations.ts`.

**Interfaces:** `runScheduled(env: Env, now: number): Promise<void>`;
Worker `scheduled(controller, env, ctx)` передає `controller.scheduledTime`.
Env доповнюється `DB: D1Database`, `ALLOWED_TELEGRAM_IDS?: string`.

- [ ] RED-тест послідовності: початкове очікування → години → незмінні години →
  змінені години → уточнення → години → none. Перевіряти фактичні повідомлення
  fake Telegram та receipts у D1, а не кількість викликів приватних helper.
- [ ] Тести: два одночасні scheduled одного часу; зміна підчерги/stop під час
  pending delivery; видалення ID зі списку; midnight; новий завтра;
  outage 18:00, нагадування за 30 — один раз між 17:30 і 17:31; restart/пропуск
  циклів не надсилає повідомлення про початок, який уже минув.
- [ ] Перевірити stale reminders без автоматичного outage-warning; успішне
  відновлення джерела без зміни годин не дублює графік; пізня публікація створює
  лише одне повідомлення, включно з all та однаковим початком кількох підчерг.
- [ ] Запустити `pnpm run test:integration -- tests/integration/scheduled.test.ts`,
  підтвердити RED; реалізувати один цикл з reusable lease ресурсу `scheduler`
  і fencing: refresh if due →
  планування змін → планування нагадувань → due delivery. Перед зовнішнім
  send перевіряти свіжість lease/revision; обмежити роботу за один виклик,
  залишок deliveries переноситься. Користувачі обробляються обмеженими порціями.
- [ ] Додати тільки один cron `* * * * *`. Наступний fetch визначає D1
  nextAttemptAt, а не modulo хвилини: backoff і рестарти зберігають паузу.
- [ ] TTL-cleanup completed operations/receipts робити після їхнього періоду
  релевантності; не прибирати дані, потрібні для дедуплікації сьогодні/завтра.
  Довести до PASS; виконати `pnpm test`, `pnpm run typecheck`, `pnpm run lint`,
  `pnpm run build`. Збірка — dry-run, без деплою.

### Task 8: Гайд налаштування й остаточна перевірка

**Files:** create `docs/deployment.md`, `scripts/telegram-webhook.mjs`,
`tests/unit/webhook-script.test.ts`; modify `README.md`, `package.json`, `CHAT_CONTEXT.md`.

**Interfaces:** CLI `pnpm run telegram:webhook -- set <https-url>` або `info`;
BOT_TOKEN/WEBHOOK_SECRET читаються лише у конфігураційній частині CLI з env.
POST setWebhook: `/webhook`, secret_token, allowed_updates message/callback_query,
без токена в stdout, history-friendly command args чи сирих exception logs.

- [ ] RED-тести CLI з fake HTTP: set передає secret_token і правильний URL,
  info не друкує секрети, HTTP/API error дає ненульовий exit, неправильний URL
  відхиляється до fetch. Не виконувати справжній setWebhook як перевірку.
- [ ] Запустити тести, підтвердити RED, реалізувати CLI й довести до PASS.
- [ ] Написати український гайд із командами pnpm: BotFather → свій Telegram ID
  без стороннього бота (тимчасовий getUpdates до webhook, без друку всього update)
  → allowlist → Cloudflare login → D1 create → підстановка binding/ID → local
  migrations/test → remote migrations → secrets → deploy → setWebhook → info.
  Не використовувати getUpdates одночасно з активним webhook.
- [ ] Пояснити безпечне відключення cron/бота, окремі перемикачі підписок, tail
  без секретів, відновлення після збою, перенесення токена та процедуру повторного
  налаштування webhook після зміни secret. Перевірити актуальні тарифи/ліміти
  перед реальним запуском; зафіксувати вимірювання CPU і D1 для малого allowlist.
- [ ] У README чітко відділити перевірене локально від перевірки на реальному
  Telegram після окремого дозволу. Не заявляти, що бот уже захощений.
- [ ] Фінальні `pnpm test`, `pnpm run typecheck`, `pnpm run lint`, `pnpm run build`
  мають пройти. Тести не потребують мережі/акаунтів. Перевірити покриття всіх
  22 вимог специфікації сценаріями, перелічити невиконані зовнішні перевірки.
  Запропонувати Conventional Commit, але не створювати його без запиту.

## Самоперевірка плану та джерела

- Усі 22 погоджені рішення покривають задачі 4–7; доступ/приватність — 2, 5, 6;
  джерело й давність — 1, 3; хостинг — 8. Review Focus прив'язано до RED-тестів.
- Task 1 не залежить від D1; Task 2 не залежить від Telegram. Подальші задачі
  використовують саме визначені вище типи й сигнатури, без паралельних альтернатив.
- У кожній програмній задачі: конкретні тести → очікуваний RED → мінімальна
  реалізація → PASS. Документацію не перевіряти тестом на збіг фрагментів тексту.
- На момент складання плану змінено лише документацію; тести нового функціоналу
  ще не написані та не виконані. Фактичні значення маркерів сайту перевіряє Task 1.
- [Cloudflare: поточна інтеграція Vitest](https://developers.cloudflare.com/workers/testing/vitest-integration/write-your-first-test/)
- [D1: batch і binding API](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [Drizzle D1](https://orm.drizzle.team/docs/sqlite/connect-cloudflare-d1)
