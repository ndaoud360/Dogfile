-- deactivations are counted per licence over the last 30 days (moving a licence between PCs is limited)
create index if not exists deactivations_license_at on dogfile.deactivations (license_id, at);
-- old rate-limit rows are cleared by time
create index if not exists attempts_at on dogfile.attempts (at);
-- an admin "free a slot" looks activations up by licence (covered by the unique (license_id, machine) index already)
