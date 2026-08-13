Check whether the team's shared knowledge repo changed, and notify the user if
it did. You are the llm-summary variant of the shared-memory plugin's digest;
the sibling `digest` schedule handles the fixed-format variant.

Follow these steps exactly.

1. From the workspace root, run:

   ```bash
   bash plugins/shared-memory/schedules/digest/index.sh --collect
   ```

   It prints one JSON document.

2. If `status` is not `changes`, or `mode` is not `llm`, stop here and do
   nothing else. No output, no notification. (When `mode` is `deterministic`,
   the sibling schedule owns the notification; sending one here too would
   notify the user twice.)

3. Otherwise, write a short, friendly summary (2–4 sentences) of what changed
   in the shared knowledge repo, from the `authors` and `commits` fields. Name
   every author in `authors` and say what they added, updated, or removed,
   with counts and the skill or page names. Use only what the JSON says —
   never invent, merge, or drop entries. Accuracy over flourish. Then send it:

   ```bash
   assistant notifications send \
     --source-channel scheduler \
     --source-event-name schedule.notify \
     --is-async-background \
     --title "Shared knowledge updates" \
     --message "<your summary>" \
     --dedupe-key "<the dedupeKey value from the JSON>"
   ```

   Keep the `--is-async-background` flag: without it the notification goes
   out as a client-only push and never reaches the home feed the Vellum app
   shows.

4. Only after the send succeeds, advance the digest watermark, passing the
   `range.end` value from the JSON:

   ```bash
   bash plugins/shared-memory/schedules/digest/index.sh --advance <range.end>
   ```

   If you fail before this step, do not retry the send yourself: the next
   scheduled run regenerates the digest, and the dedupe key keeps the user
   from being notified twice.
