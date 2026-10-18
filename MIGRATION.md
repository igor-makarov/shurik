# Migrating from v1 to v2

Version 2 changes the action/workflow/CLI model inputs and adds swarm startup. Existing v1 tags stay on v1 code. Consumers opt in by updating their workflow; no other consumer repository is migrated automatically.

1. Stop active v1 loops before replacing the workflow, so queued v1 continuations cannot dispatch removed workflow inputs.
2. Replace the consumer workflow with [the v2 template](examples/consumer/.github/workflows/shurik.yml), retaining your provider secret environment variables. All action references must use `igor-makarov/shurik@v2`.
3. Remove separate `provider` and `reasoning` inputs, bare model-name values, and YAML model fallback expressions. The model input is now JSON:

   ```yaml
   model: '{"provider":"openai","name":"gpt-6-sol","reasoning":"high"}'
   ```

4. Move operational settings from `.shurik/config.json` into workflow/action inputs or accept Shurik's built-in defaults. V2 ignores that file. Omitted start settings use 1,800 work seconds, zero wait seconds, 300 checkpoint seconds, `PROMPT.md`, an empty checkpoint-path list, and automatic draft PR creation. There is no model default.
5. Resume retained loops by their existing IDs. A blank model preserves the saved provider/name/reasoning; a partial object such as `{"reasoning":"medium"}` overrides selected fields. Changing provider requires a corresponding explicit name. Blank resume work/wait inputs retain saved values; a blank deadline clears the old deadline. Stop active work before resume.

Control records retain their flat provider, model and reasoning fields. Task branches, control refs, journals, session IDs and checkpoint layouts are not renamed or migrated. Controls without a provider retain their previous OpenCode interpretation. Legacy self-hosted loops still require their compatible pinned supervisor; the v2 interface does not migrate that engine mode.

## Starting a swarm

Supply a shared model and `swarm: '{"agents":4}'`, or a swarm model list. Count-only swarms replicate the shared model. Entries in `models` override shared fields; standalone entries must resolve all three model fields. An explicit `agents` count must match the model list length.

The input loop ID is a prefix: research generates research-0 through research-3. Even a one-member swarm uses the -0 suffix. A start without swarm retains the exact input ID. Generated IDs must fit the existing 49-character limit.

One control job starts the members; there is no matrix. Members independently schedule iterations and persist separate branches, models, journals and control state. Stop/resume use individual IDs. Initial context and loop.json identify the member's swarm, zero-based index and size.

Startup validates the complete plan before initialization, but external GitHub failures can leave a partially started swarm. Inspect the per-loop summaries. Scheduled recovery can retry missing dispatches; for manual recovery, stop and resume initialized members and start missing IDs individually with their resolved models. Path outputs become newline-separated lists for swarms; the emergency output works directly with actions/upload-artifact. The new loop-ids output is a JSON array.

No inter-agent communication, common writable workspace or automatic integration is included in v2.
