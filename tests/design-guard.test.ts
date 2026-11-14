// Ticket 053 FR-5: design-system guard. Primary actions use `<Button variant="primary">` (teal, Figma `bg/brand`), not the
// CareThread-era `bg-slate-900 text-white`. Implemented as a test (D-2: eslint.config.mjs has local edits).
// It scans app/** and components/** (except components/landing/**, FR-4) with the TypeScript parser and fails on:
//   1. a <button>, <Link> or <a> whose className resolves (string literals, template literals, same-file or imported
//      constants, same-file helper functions) to both `bg-slate-900` and `text-white`;
//   2. a class string in a plain .ts module holding both tokens (shared button class constants).
// Dark surfaces that are not buttons (Figma `bg/inverse`, e.g. the voice panel) are not matched by rule 1; anything
// else that must stay goes in ALLOWED with a reason.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..");
const SCAN = ["app", "components"];
const SKIP = [path.join("components", "landing") + path.sep];
const INTERACTIVE = new Set(["button", "Link", "a"]);

/** `file:line` → reason. Keep empty unless a dark button is a deliberate design decision. */
const ALLOWED: Record<string, string> = {};

type Hit = { file: string; line: number; tag: string; text: string };

function hasPrimarySlate(text: string): boolean {
  const tokens = new Set(text.split(/\s+/));
  return tokens.has("bg-slate-900") && tokens.has("text-white");
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listFiles(full));
    else if (/\.tsx?$/.test(name) && !name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

const parsed = new Map<string, ts.SourceFile>();
function parse(file: string, source?: string): ts.SourceFile {
  const key = source === undefined ? file : `${file}#inline`;
  let sf = parsed.get(key);
  if (!sf) {
    const text = source ?? readFileSync(file, "utf8");
    sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    parsed.set(key, sf);
  }
  return sf;
}

function resolveImport(from: string, spec: string): string | null {
  const base = spec.startsWith("@/") ? path.join(ROOT, spec.slice(2)) : spec.startsWith(".") ? path.resolve(path.dirname(from), spec) : null;
  if (!base) return null;
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand;
  }
  return null;
}

/** Top-level `const x = ...` / `function x() {}` declarations and named imports of a file. */
function declarations(sf: ts.SourceFile) {
  const consts = new Map<string, ts.Node>();
  const imports = new Map<string, { file: string; name: string }>();
  for (const st of sf.statements) {
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name) && d.initializer) consts.set(d.name.text, d.initializer);
    } else if (ts.isFunctionDeclaration(st) && st.name && st.body) {
      consts.set(st.name.text, st.body);
    } else if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier) && st.importClause?.namedBindings) {
      const target = resolveImport(sf.fileName, st.moduleSpecifier.text);
      const nb = st.importClause.namedBindings;
      if (target && ts.isNamedImports(nb)) {
        for (const el of nb.elements) imports.set(el.name.text, { file: target, name: (el.propertyName ?? el.name).text });
      }
    }
  }
  return { consts, imports };
}

/** Every class-ish string a className expression can produce, joined (over-approximation is fine for a guard). */
function classText(node: ts.Node, sf: ts.SourceFile, seen = new Set<string>()): string {
  const parts: string[] = [];
  const { consts, imports } = declarations(sf);
  const visit = (n: ts.Node) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) parts.push(n.text);
    else if (ts.isTemplateExpression(n)) {
      parts.push(n.head.text);
      for (const span of n.templateSpans) {
        visit(span.expression);
        parts.push(span.literal.text);
      }
      return;
    } else if (ts.isIdentifier(n)) {
      const key = `${sf.fileName}:${n.text}`;
      if (seen.has(key)) return;
      seen.add(key);
      const local = consts.get(n.text);
      if (local) parts.push(classText(local, sf, seen));
      const imp = imports.get(n.text);
      if (imp) {
        const other = parse(imp.file);
        const target = declarations(other).consts.get(imp.name);
        if (target) parts.push(classText(target, other, seen));
      }
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return parts.join(" ");
}

function scanSource(file: string, source?: string): Hit[] {
  const sf = parse(file, source);
  const rel = path.relative(ROOT, file);
  const hits: Hit[] = [];
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const visit = (n: ts.Node) => {
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
      const tag = n.tagName.getText(sf);
      if (INTERACTIVE.has(tag)) {
        for (const attr of n.attributes.properties) {
          if (ts.isJsxAttribute(attr) && attr.name.getText(sf) === "className" && attr.initializer) {
            const text = classText(attr.initializer, sf);
            if (hasPrimarySlate(text)) hits.push({ file: rel, line: lineOf(n), tag, text: text.slice(0, 160) });
          }
        }
      }
    }
    if (!file.endsWith(".tsx") && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && hasPrimarySlate(n.text)) {
      hits.push({ file: rel, line: lineOf(n), tag: "(class constant)", text: n.text.slice(0, 160) });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return hits;
}

describe("053 design guard: no slate-900 primary buttons", () => {
  it("the scanner flags slate primary buttons and links, and ignores dark surfaces", () => {
    const flagged = scanSource(
      path.join(ROOT, "components/__guard__/Fixture.tsx"),
      `import Link from "next/link";
       const btn = "min-h-11 rounded px-4";
       const primary = \`\${btn} bg-slate-900 text-white\`;
       function tone(on: boolean) { return on ? "bg-slate-900 text-white" : "bg-white"; }
       export function A({ on }: { on: boolean }) {
         return (<>
           <button className="rounded bg-slate-900 px-4 text-white">Save</button>
           <Link href="/x" className={primary}>Go</Link>
           <a href="/y" className={tone(on)}>Tab</a>
           <button className={\`\${on ? "bg-slate-900" : ""} text-white\`}>Split</button>
           <div className="bg-slate-900 text-white">Voice panel (bg/inverse)</div>
           <dialog className="backdrop:bg-slate-900/50"><button className="bg-teal-700 text-white">Ok</button></dialog>
           <button className="hover:bg-slate-900 text-white">Not a base class</button>
         </>);
       }`,
    );
    expect(flagged.map((h) => h.tag)).toEqual(["button", "Link", "a", "button"]);
    const constants = scanSource(path.join(ROOT, "components/__guard__/styles.ts"), `export const primary = "rounded bg-slate-900 px-4 text-white";`);
    expect(constants).toHaveLength(1);
  });

  it("app/** and components/** have no slate-900 + text-white buttons or links outside the allowed list", () => {
    const files = SCAN.flatMap((d) => listFiles(path.join(ROOT, d))).filter((f) => !SKIP.some((s) => path.relative(ROOT, f).startsWith(s)));
    expect(files.length).toBeGreaterThan(100);
    const hits = files.flatMap((f) => scanSource(f)).filter((h) => !ALLOWED[`${h.file}:${h.line}`]);
    expect(hits.map((h) => `${h.file}:${h.line} <${h.tag}> ${h.text}`)).toEqual([]);
  });
});
