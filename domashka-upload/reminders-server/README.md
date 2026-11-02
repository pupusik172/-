# Daily homework reminder

This Sites service must remain owner-private. Sites dispatch authenticates both
the owner and unattended calls carrying current service access obtained through
`get_site`. The worker does not expose a public sending endpoint.

Runtime secrets: `BOT_TOKEN`, `REMINDER_CHAT_ID`. They are configured in Sites,
never in source. The recipient is fixed by server configuration.

`POST /reminders/homework` accepts `{ "dry_run": false }`. The message is exactly
`не забудь внести домашнее задание`. Sending is allowed only in the 17th hour in
`Europe/Moscow`; successful delivery receipts are retained in R2 to avoid repeats.
`dry_run: true` verifies Telegram chat access without sending or writing a receipt.

The linked Sites cloud schedule runs daily at 17:00 Europe/Moscow. Each run should
obtain fresh service access through `get_site`, invoke this operation once and
check its JSON response. Do not retry a network request with an uncertain outcome.
No republishing, browser use, or local computer is required for routine runs.

## Deadline reminders

`POST /reminders/deadlines` accepts `{ "dry_run": false }`. A separate linked
cloud schedule invokes it daily at 17:00 Europe/Moscow. The existing daily
homework-entry reminder is independent and retains its original text and time.

The worker reads minimal task metadata from the media service using runtime
`DEADLINE_SOURCE_URL` and secret `DEADLINE_SERVICE_KEY`. The Mini App registers
existing homework on its next launch inside Telegram and queues subsequent
create/edit/complete/delete changes without uploading photographs to this index.
Registration cannot overwrite newer task states or resurrect deleted records.

Unfinished homework triggers `до сдачи Д/З осталось 2 дня` two calendar days before
its deadline, and `до сдачи Д/З остался 1 день` one day before. The subject, title
and due date follow on separate lines. Status is read again immediately before
sending. Completed, deleted, undated and rescheduled homework is skipped.
Atomic R2 claims prevent duplicate messages for each homework/deadline/stage.

`dry_run: true` verifies task-source and Telegram access without sending.
`POST /reminders/deadlines/test` accepts `{ "request_id": "unique-check-id" }`
and sends one explicitly labeled test message, independent of delivery time.
