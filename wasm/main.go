// Package main exposes go-jsonnet's raw parser and lexer to JavaScript via a
// thin WebAssembly bridge. The build script (../wasm/build.sh) copies this
// file into a freshly-cloned copy of the upstream go-jsonnet module so it
// can legally import the `internal/parser` package.
//
// The JS side calls `globalThis.jsonnet_parse(filename, code)` and receives a
// JSON string with this shape:
//
//	{
//	  "ast":      <recursive node tree>,
//	  "tokens":   [{ "type", "value", "range", "loc" }, ...],
//	  "comments": [{ "type", "value", "range", "loc" }, ...]
//	}
//
// Each AST node carries `nodeType` (the concrete Go type name), `range`
// (`[start, end]` UTF-16 character offsets), `loc` (`{start, end}` of
// `{line, column}` with 1-indexed lines and 0-indexed UTF-16 columns —
// the ESLint convention), and the exported fields of the Go node type with
// leading-lower-cased keys.
//
// On parse failure the bridge still returns the tokens and comments it could
// scan, plus an `error` string instead of `ast`. The JS side surfaces that
// as a `JsonnetParseError` node so linting can continue on the rest of the
// file.
package main

import (
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"syscall/js"
	"unicode/utf8"

	"github.com/google/go-jsonnet/ast"
	"github.com/google/go-jsonnet/internal/parser"
)

// astNodeType is the reflect.Type of the ast.Node interface. The recursive
// serialiser uses it to detect AST values without listing every concrete node.
var astNodeType = reflect.TypeOf((*ast.Node)(nil)).Elem()

// ---------------------------------------------------------------------------
// Position table
// ---------------------------------------------------------------------------

// positions caches mappings from go-jsonnet's (line, byte-column) coordinates
// to ESLint-friendly (UTF-16 char offset, UTF-16 column) coordinates so each
// node's range can be looked up in O(1).
type positions struct {
	lineByteStarts []int
	lineCharStarts []int
	byteToChar     []int
	source         string
}

func buildPositions(code string) *positions {
	lineByteStarts := []int{0}
	lineCharStarts := []int{0}
	byteToChar := make([]int, len(code)+1)

	charIdx := 0
	i := 0
	for i < len(code) {
		byteToChar[i] = charIdx
		r, size := utf8.DecodeRuneInString(code[i:])
		// JS strings are UTF-16; supplementary-plane runes occupy two code
		// units. ESLint columns count in UTF-16 code units, so we need to
		// account for that here.
		if r >= 0x10000 {
			charIdx += 2
		} else {
			charIdx++
		}
		if r == '\n' {
			lineByteStarts = append(lineByteStarts, i+size)
			lineCharStarts = append(lineCharStarts, charIdx)
		}
		i += size
	}
	byteToChar[len(code)] = charIdx

	return &positions{
		lineByteStarts: lineByteStarts,
		lineCharStarts: lineCharStarts,
		byteToChar:     byteToChar,
		source:         code,
	}
}

// charOffset converts a (line, byte-column) pair as produced by go-jsonnet
// into an absolute UTF-16 character offset.
func (p *positions) charOffset(line, byteCol int) int {
	if line <= 0 || line > len(p.lineByteStarts) {
		return p.byteToChar[len(p.source)]
	}
	byteOffset := p.lineByteStarts[line-1] + byteCol - 1
	if byteOffset < 0 {
		byteOffset = 0
	}
	if byteOffset > len(p.source) {
		byteOffset = len(p.source)
	}
	return p.byteToChar[byteOffset]
}

func (p *positions) charColumn(line, byteCol int) int {
	if line <= 0 || line > len(p.lineCharStarts) {
		return 0
	}
	return p.charOffset(line, byteCol) - p.lineCharStarts[line-1]
}

func (p *positions) byteOffset(line, byteCol int) int {
	if line <= 0 || line > len(p.lineByteStarts) {
		return len(p.source)
	}
	off := p.lineByteStarts[line-1] + byteCol - 1
	if off < 0 {
		return 0
	}
	if off > len(p.source) {
		return len(p.source)
	}
	return off
}

// locFromByteOffset turns a raw byte offset into an ESLint `{line, column}`
// position. Lines are 1-indexed, columns are 0-indexed UTF-16 code units.
func (p *positions) locFromByteOffset(byteOffset int) map[string]any {
	if byteOffset < 0 {
		byteOffset = 0
	}
	if byteOffset > len(p.source) {
		byteOffset = len(p.source)
	}
	lo, hi := 0, len(p.lineByteStarts)-1
	for lo < hi {
		mid := (lo + hi + 1) / 2
		if p.lineByteStarts[mid] <= byteOffset {
			lo = mid
		} else {
			hi = mid - 1
		}
	}
	line := lo + 1
	column := p.byteToChar[byteOffset] - p.lineCharStarts[lo]
	return map[string]any{"line": line, "column": column}
}

// ---------------------------------------------------------------------------
// AST → JSON
// ---------------------------------------------------------------------------

func lowerFirst(s string) string {
	if s == "" {
		return s
	}
	return strings.ToLower(s[:1]) + s[1:]
}

func nodeToMap(n ast.Node, pos *positions) map[string]any {
	if n == nil {
		return nil
	}
	v := reflect.ValueOf(n)
	if v.Kind() == reflect.Ptr {
		if v.IsNil() {
			return nil
		}
		v = v.Elem()
	}
	t := v.Type()
	result := map[string]any{
		"nodeType": t.Name(),
	}
	attachLocation(result, n.Loc(), pos)

	for i := 0; i < t.NumField(); i++ {
		f := t.Field(i)
		if !f.IsExported() {
			continue
		}
		// NodeBase carries LocRange (already on `loc`/`range`), Fodder
		// (covered by the comment table), Ctx, and FreeVars — none of
		// which are useful to ESLint rules.
		if f.Anonymous && f.Type.Name() == "NodeBase" {
			continue
		}
		result[lowerFirst(f.Name)] = valueToInterface(v.Field(i), pos)
	}
	return result
}

func attachLocation(target map[string]any, lr *ast.LocationRange, pos *positions) {
	if lr == nil || !lr.IsSet() {
		return
	}
	start := pos.charOffset(lr.Begin.Line, lr.Begin.Column)
	end := pos.charOffset(lr.End.Line, lr.End.Column)
	target["range"] = []any{start, end}
	target["loc"] = map[string]any{
		"start": map[string]any{
			"line":   lr.Begin.Line,
			"column": pos.charColumn(lr.Begin.Line, lr.Begin.Column),
		},
		"end": map[string]any{
			"line":   lr.End.Line,
			"column": pos.charColumn(lr.End.Line, lr.End.Column),
		},
	}
}

func valueToInterface(v reflect.Value, pos *positions) any {
	if !v.IsValid() {
		return nil
	}
	switch v.Kind() {
	case reflect.Ptr:
		if v.IsNil() {
			return nil
		}
		if v.Type().Implements(astNodeType) {
			return nodeToMap(v.Interface().(ast.Node), pos)
		}
		return valueToInterface(v.Elem(), pos)
	case reflect.Interface:
		if v.IsNil() {
			return nil
		}
		if v.Type().Implements(astNodeType) {
			return nodeToMap(v.Interface().(ast.Node), pos)
		}
		return valueToInterface(v.Elem(), pos)
	case reflect.Slice, reflect.Array:
		out := make([]any, 0, v.Len())
		for i := 0; i < v.Len(); i++ {
			out = append(out, valueToInterface(v.Index(i), pos))
		}
		return out
	case reflect.Map:
		out := map[string]any{}
		iter := v.MapRange()
		for iter.Next() {
			out[fmt.Sprint(iter.Key().Interface())] = valueToInterface(iter.Value(), pos)
		}
		return out
	case reflect.Struct:
		if v.Type().Name() == "LocationRange" {
			lr := v.Interface().(ast.LocationRange)
			loc := map[string]any{}
			attachLocation(loc, &lr, pos)
			return loc
		}
		if v.CanAddr() {
			addr := v.Addr()
			if addr.Type().Implements(astNodeType) {
				return nodeToMap(addr.Interface().(ast.Node), pos)
			}
		}
		t := v.Type()
		out := map[string]any{}
		for i := 0; i < t.NumField(); i++ {
			f := t.Field(i)
			if !f.IsExported() {
				continue
			}
			out[lowerFirst(f.Name)] = valueToInterface(v.Field(i), pos)
		}
		return out
	case reflect.String:
		return v.String()
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return v.Int()
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		return v.Uint()
	case reflect.Float32, reflect.Float64:
		return v.Float()
	case reflect.Bool:
		return v.Bool()
	default:
		return nil
	}
}

// ---------------------------------------------------------------------------
// Token & comment extraction
// ---------------------------------------------------------------------------

// tokenKindToESLint maps the strings in go-jsonnet's tokenKindStrings table
// to ESLint-style token type names. Keywords and symbols are detected by
// exact match against the table values.
var tokenKindToESLint = map[string]string{
	`"{"`:                    "Punctuator",
	`"}"`:                    "Punctuator",
	`"["`:                    "Punctuator",
	`"]"`:                    "Punctuator",
	`","`:                    "Punctuator",
	`"."`:                    "Punctuator",
	`"("`:                    "Punctuator",
	`")"`:                    "Punctuator",
	`";"`:                    "Punctuator",
	`"$"`:                    "Punctuator",
	"IDENTIFIER":             "Identifier",
	"NUMBER":                 "Numeric",
	"OPERATOR":               "Operator",
	"STRING_BLOCK":           "String",
	"STRING_DOUBLE":          "String",
	"STRING_SINGLE":          "String",
	"VERBATIM_STRING_DOUBLE": "String",
	"VERBATIM_STRING_SINGLE": "String",
	"assert":                 "Keyword",
	"else":                   "Keyword",
	"error":                  "Keyword",
	"false":                  "Keyword",
	"for":                    "Keyword",
	"function":               "Keyword",
	"if":                     "Keyword",
	"import":                 "Keyword",
	"importstr":              "Keyword",
	"importbin":              "Keyword",
	"in":                     "Keyword",
	"local":                  "Keyword",
	"null":                   "Keyword",
	"self":                   "Keyword",
	"super":                  "Keyword",
	"tailstrict":             "Keyword",
	"then":                   "Keyword",
	"true":                   "Keyword",
}

func tokensToList(toks []parser.PublicToken, pos *positions, code string) []any {
	out := make([]any, 0, len(toks))
	for _, t := range toks {
		// The lexer appends a sentinel "end of file" token; skip it so
		// downstream consumers do not see a zero-length trailing token.
		if t.Kind == "end of file" {
			continue
		}
		eslintKind, ok := tokenKindToESLint[t.Kind]
		if !ok {
			// Unknown lexeme — preserve the raw kind so the JS side can
			// flag it instead of silently dropping the token.
			eslintKind = t.Kind
		}
		startByte := pos.byteOffset(t.Loc.Begin.Line, t.Loc.Begin.Column)
		endByte := pos.byteOffset(t.Loc.End.Line, t.Loc.End.Column)
		startChar := pos.byteToChar[startByte]
		endChar := pos.byteToChar[endByte]
		out = append(out, map[string]any{
			"type":  eslintKind,
			"value": code[startByte:endByte],
			"range": []any{startChar, endChar},
			"loc": map[string]any{
				"start": map[string]any{"line": t.Loc.Begin.Line, "column": pos.charColumn(t.Loc.Begin.Line, t.Loc.Begin.Column)},
				"end":   map[string]any{"line": t.Loc.End.Line, "column": pos.charColumn(t.Loc.End.Line, t.Loc.End.Column)},
			},
		})
	}
	return out
}

// extractComments scans the source directly for comments. The lexer turns
// comments into fodder strings without preserving their source positions,
// so we re-scan to emit ESLint-style comment nodes.
//
// Jsonnet has three comment forms:
//   - `// ...` to end of line  →  type "Line"
//   - `# ...`  to end of line  →  type "Hash"
//   - `/* ... */`              →  type "Block"
//
// The scanner is comment-only: it skips strings (so `"//"` inside a literal
// is not mistaken for a comment) but does not classify other tokens.
func extractComments(code string, pos *positions) []any {
	out := []any{}
	src := code
	i := 0
	for i < len(src) {
		c := src[i]
		switch {
		case c == '"' || c == '\'':
			i = skipQuoted(src, i, c)
		case c == '@' && i+1 < len(src) && (src[i+1] == '"' || src[i+1] == '\''):
			i = skipVerbatim(src, i)
		case c == '|' && i+2 < len(src) && src[i+1] == '|' && src[i+2] == '|':
			i = skipTextBlock(src, i)
		case c == '/' && i+1 < len(src) && src[i+1] == '/':
			start := i
			for i < len(src) && src[i] != '\n' {
				i++
			}
			out = append(out, commentMap("Line", code, start, i, src[start+2:i], pos))
		case c == '#':
			start := i
			for i < len(src) && src[i] != '\n' {
				i++
			}
			out = append(out, commentMap("Hash", code, start, i, src[start+1:i], pos))
		case c == '/' && i+1 < len(src) && src[i+1] == '*':
			start := i
			i += 2
			for i+1 < len(src) && !(src[i] == '*' && src[i+1] == '/') {
				i++
			}
			if i+1 < len(src) {
				i += 2
			} else {
				i = len(src)
			}
			value := src[start+2:]
			if strings.HasSuffix(src[start:i], "*/") {
				value = src[start+2 : i-2]
			}
			out = append(out, commentMap("Block", code, start, i, value, pos))
		default:
			i++
		}
	}
	return out
}

func commentMap(kind, code string, start, end int, value string, pos *positions) map[string]any {
	startChar := pos.byteToChar[start]
	endChar := pos.byteToChar[end]
	return map[string]any{
		"type":  kind,
		"value": value,
		"range": []any{startChar, endChar},
		"loc": map[string]any{
			"start": pos.locFromByteOffset(start),
			"end":   pos.locFromByteOffset(end),
		},
	}
}

func skipQuoted(src string, i int, quote byte) int {
	i++
	for i < len(src) {
		c := src[i]
		if c == '\\' && i+1 < len(src) {
			i += 2
			continue
		}
		if c == quote {
			return i + 1
		}
		i++
	}
	return i
}

func skipVerbatim(src string, i int) int {
	// Consume the leading `@`.
	i++
	quote := src[i]
	i++
	for i < len(src) {
		if src[i] == quote {
			if i+1 < len(src) && src[i+1] == quote {
				i += 2
				continue
			}
			return i + 1
		}
		i++
	}
	return i
}

func skipTextBlock(src string, i int) int {
	i += 3
	for i < len(src) && src[i] != '\n' {
		i++
	}
	if i < len(src) {
		i++
	}
	for i+2 < len(src) {
		if src[i] == '|' && src[i+1] == '|' && src[i+2] == '|' {
			return i + 3
		}
		i++
	}
	return len(src)
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

func parseSnippet(this js.Value, args []js.Value) any {
	if len(args) < 2 {
		return mustJSON(map[string]any{"error": "jsonnet_parse: expected (filename, code)"})
	}
	filename := args[0].String()
	code := args[1].String()

	pos := buildPositions(code)
	out := map[string]any{
		"comments": extractComments(code, pos),
	}

	// Lex even if the parser ultimately fails so the JS side still gets a
	// token stream for non-AST consumers (e.g. an editor highlighter using
	// this parser).
	toks, lexErr := parser.Lex(ast.DiagnosticFileName(filename), filename, code)
	if lexErr == nil {
		out["tokens"] = tokensToList(parser.TokensExport(toks), pos, code)
	} else {
		out["tokens"] = []any{}
		out["lexError"] = lexErr.Error()
	}

	node, _, parseErr := parser.SnippetToRawAST(ast.DiagnosticFileName(filename), filename, code)
	if parseErr != nil {
		out["error"] = parseErr.Error()
		return mustJSON(out)
	}
	out["ast"] = nodeToMap(node, pos)
	return mustJSON(out)
}

func mustJSON(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		fallback, _ := json.Marshal(err.Error())
		return `{"error":` + string(fallback) + `}`
	}
	return string(b)
}

func main() {
	js.Global().Set("jsonnet_parse", js.FuncOf(parseSnippet))
	// Park the Go runtime so the registered function stays callable for
	// the lifetime of the host JS process.
	select {}
}
