#!/usr/bin/env bash
# Build the go-jsonnet WebAssembly bridge.
#
# go-jsonnet keeps both the raw parser and the lexer behind its `internal/`
# fence so they can only be reached from inside the upstream module. To call
# them, this script clones go-jsonnet at a pinned version, drops our `main.go`
# into a fresh `wasm-bridge/` subdirectory of the clone, and builds from
# there — that path is "inside" the go-jsonnet module so the import is legal.
# The clone is cached under `.cache/` and refreshed only when
# JSONNET_GO_VERSION changes.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

JSONNET_GO_VERSION="${JSONNET_GO_VERSION:-v0.22.0}"
CACHE_DIR="$HERE/.cache"
CLONE_DIR="$CACHE_DIR/go-jsonnet-$JSONNET_GO_VERSION"
BRIDGE_DIR="$CLONE_DIR/wasm-bridge"
OUT_DIR="$HERE/../src/wasm"

mkdir -p "$CACHE_DIR" "$OUT_DIR"

if [ ! -d "$CLONE_DIR/.git" ]; then
  rm -rf "$CLONE_DIR"
  git clone --depth 1 --branch "$JSONNET_GO_VERSION" https://github.com/google/go-jsonnet.git "$CLONE_DIR"
fi

# Stage our bridge source inside the upstream module. Anything in
# `wasm-bridge/` is regenerated on every build so we never depend on stale
# files in the clone.
rm -rf "$BRIDGE_DIR"
mkdir -p "$BRIDGE_DIR"
cp "$HERE/main.go" "$BRIDGE_DIR/main.go"

# Drop an accessor file into `internal/parser` so the bridge can read the
# unexported token fields. The file is regenerated on every build so it
# stays in sync with main.go's expectations.
cat > "$CLONE_DIR/internal/parser/external_accessor.go" <<'GO'
// Added by jsonnet-eslint-parser's build script.
//
// The bridge in ../wasm-bridge/main.go imports this package to reach the
// lexer, but go-jsonnet keeps the token struct and its fields unexported.
// This file lives inside the parser package so it can copy each token into
// a publicly-shaped struct that callers in sibling packages can consume.
package parser

import "github.com/google/go-jsonnet/ast"

// PublicToken is a serialisable view of an internal token.
type PublicToken struct {
	Kind string
	Data string
	Loc  ast.LocationRange
}

// TokensExport copies tokens out of the parser package so callers outside
// the package can iterate them by exported-only fields. The end-of-file
// sentinel is preserved here; downstream consumers are responsible for
// filtering it.
func TokensExport(toks Tokens) []PublicToken {
	out := make([]PublicToken, 0, len(toks))
	for _, t := range toks {
		out = append(out, PublicToken{
			Kind: tokenKindStrings[t.kind],
			Data: t.data,
			Loc:  t.loc,
		})
	}
	return out
}
GO

cd "$BRIDGE_DIR"
GOOS=js GOARCH=wasm go build -trimpath -ldflags="-s -w" -o "$OUT_DIR/jsonnet.wasm" .

# Copy wasm_exec.js out of the Go toolchain so runtime dependants do not
# need a Go install on their machine.
install -m 644 "$(go env GOROOT)/lib/wasm/wasm_exec.js" "$OUT_DIR/wasm_exec.js"

echo "built $OUT_DIR/jsonnet.wasm ($(wc -c <"$OUT_DIR/jsonnet.wasm") bytes)"
