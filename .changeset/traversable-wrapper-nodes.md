---
"jsonnet-eslint-parser": minor
---

Make the AST fully traversable by ESLint.

go-jsonnet models several child-bearing structures as plain records rather
than nodes: an object's `fields`, a `local`'s `binds`, an array's
`elements`, a function's `parameters`, an apply's `arguments` (with its
`positional` / `named` lists) and a comprehension's `spec` (with its
`conditions`). Previously these reached the ESLint shape without a `type`,
so ESLint's traverser bailed at them and never descended into their
children. In practice that meant a rule's visitors only fired on top-level
nodes — anything nested inside `local x = {...}` or `[ {...} ]` (i.e. the
bulk of a real Jsonnet file) was unreachable.

These wrappers are now promoted to proper nodes with a `type`
(`ObjectField`, `LocalBind`, `ArrayElement`, `Parameter`, `ApplyArguments`,
`PositionalArgument`, `NamedArgument`, `ForSpec`, `IfSpec`) and a
`range`/`loc` spanning their child nodes, and they are included in
`visitorKeys`. The original metadata (`kind`, `hide`, `id`, fodder, …) is
preserved.

The parser also now exposes `meta` (`name` / `version`) for ESLint flat
config; `version` is read from package.json so it never drifts.
