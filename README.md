# mend — one patch tool for every AI edit format

`mend` applies AI-written edits to a tree of files. It reads four formats and
applies them all, or none at all:

- **Unified diffs** — `diff --git` / `---` + `+++` sections with `@@` hunks.
  The line numbers in a hunk are a hint, not a promise: mend finds the
  nearest matching location in the file, even when the patch's numbers are
  wrong or the context has drifted.
- **SEARCH/REPLACE blocks** — `<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE`,
  with an optional file path on the line above each block.
- **V4A patches** — `*** Begin Patch` / `*** End Patch`, with `*** Add File:`,
  `*** Delete File:`, `*** Update File:` (with `@@` anchors, `*** Move to:`,
  and `*** End of File`) and `*** Move to:` renames.
- **JSON tool calls** — a JSON object (or one per line) naming `create_file`,
  `str_replace`, `insert`, `create_directory`, `delete_file`, `rename_file`,
  `move_file`, `delete_directory`, and other file tools, in the shape AI
  coding tools emit them.

## Matching

An edit's "old" lines are matched against the file in three tiers, best
first: exact bytes, then ignoring trailing whitespace, then ignoring leading
and trailing whitespace (re-indenting the new lines to the file's own
indentation). `--strict` disables tiers 1 and 2, so only exact matches apply.

## Usage

```
mend [--format=<format>] [--check] [--strict] [PATCH]
```

- `PATCH` is a patch file; `-` or no argument reads the patch from stdin.
- `--format` is one of `unified`, `search-replace`, `v4a`, `json`. Without it,
  mend detects the format from the patch text.
- `--check` runs the patch and reports what would change, without writing.
- `--strict` requires exact matches only.

Exit codes: `0` applied (or would apply), `1` one or more edits failed,
`2` usage, no-patch, format, or parse error. On exit `0` mend prints one
line per changed file (`A`, `M`, `D`, `R old -> new`) and `ok: N files`.
On exit `1` it prints one `failed: <n> <edit>` line per failed edit and
`failed: k of n edits`, and writes nothing. A patch is applied atomically:
either every edit lands or no file is touched.

## Requirements

Node.js 22 or newer, standard library only — no dependencies.

## Files

- `main.ts` — the CLI (the whole tool).
- `runner.ts` — the kit's check runner (unchanged from the kit).
- `check.ts` — runs the 100 public practice checks in
  `program/generator/practice.json` against `main.ts`.
- `SPEC.md` — the full specification this tool implements.

## License

MIT. See `LICENSE`.
