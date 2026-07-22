// Guards for the CLI command table.
//
// help-catalog.ts is now the only place a flag is declared: assertKnownFlags()
// reads it through specFor(), `--help` renders from it, and docs-site generates
// the published CLI reference from it. That removes the old three-way drift
// (runner allow-list, help template, hand-written docs page) by construction,
// so these tests cover what construction alone cannot: that the table stays
// internally consistent and stays in step with the dispatcher.

import { describe, it, expect } from "vitest";
import {
  allNouns,
  nounSpec,
  specFor,
  renderNounHelp,
  renderRootHelp,
  usageLine,
} from "./help-catalog.js";

// Every noun `main()` dispatches on. Kept as a literal rather than imported so
// the test fails loudly if a noun is added to the CLI and nowhere else; the
// point is to notice, not to agree with index.ts automatically.
const DISPATCHED = [
  "deploy",
  "apps",
  "data",
  "members",
  "grants",
  "ingest",
  "key",
  "taste",
  "feedback",
  "attachment",
  "agent",
  "config",
  "skill",
];

describe("help catalog", () => {
  it("covers exactly the nouns the CLI dispatches", () => {
    expect(
      allNouns()
        .map((n) => n.noun)
        .sort(),
    ).toEqual([...DISPATCHED].sort());
  });

  it("resolves specFor for every declared verb", () => {
    for (const noun of allNouns()) {
      for (const v of noun.verbs) {
        const [flags, bools, help] = specFor(noun.noun, v.verb);
        expect(Array.isArray(flags)).toBe(true);
        expect(Array.isArray(bools)).toBe(true);
        expect(help).toBe(
          ["homespun", noun.noun, v.verb].filter(Boolean).join(" "),
        );
      }
    }
  });

  it("throws on an unknown noun or verb rather than silently allowing everything", () => {
    expect(() => specFor("nope")).toThrow(/no such noun/);
    expect(() => specFor("apps", "nope")).toThrow(/has no verb/);
  });

  it("never redeclares a global flag on a verb", () => {
    // GLOBAL_FLAGS / GLOBAL_BOOLS in argv.ts are unioned in by
    // assertKnownFlags, so repeating one here is noise that drifts. The one
    // deliberate exception is `config add --api-key`, which is a real argument
    // to that command and not the global credential override.
    const GLOBALS = new Set(["url", "profile", "help", "json"]);
    const offenders: string[] = [];
    for (const noun of allNouns()) {
      for (const v of noun.verbs) {
        for (const f of [...(v.flags ?? []), ...(v.bools ?? [])]) {
          if (GLOBALS.has(f.name)) {
            offenders.push(`${noun.noun} ${v.verb} --${f.name}`.trim());
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps flag names unique per verb and kebab-cased", () => {
    const problems: string[] = [];
    for (const noun of allNouns()) {
      for (const v of noun.verbs) {
        const names = [...(v.flags ?? []), ...(v.bools ?? [])].map(
          (f) => f.name,
        );
        const dupes = names.filter((n, i) => names.indexOf(n) !== i);
        for (const d of dupes) {
          problems.push(`${noun.noun} ${v.verb}: duplicate --${d}`.trim());
        }
        for (const n of names) {
          if (!/^[a-z][a-z0-9-]*$/.test(n)) {
            problems.push(
              `${noun.noun} ${v.verb}: --${n} is not kebab-case`.trim(),
            );
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("gives every boolean flag no value placeholder", () => {
    const problems: string[] = [];
    for (const noun of allNouns()) {
      for (const v of noun.verbs) {
        for (const b of v.bools ?? []) {
          if (b.value) {
            problems.push(`${noun.noun} ${v.verb} --${b.name}`.trim());
          }
        }
      }
    }
    // A boolean with a placeholder would render as if it took a value, which is
    // exactly the confusion that produced #827.
    expect(problems).toEqual([]);
  });

  it("holds no em or en dashes anywhere", () => {
    // House style, and check-no-dashes.mjs scans the generated docs page. Fail
    // here first so the message names the field instead of a built artifact.
    const dash = /[\u2013\u2014]/;
    const problems: string[] = [];
    for (const noun of allNouns()) {
      const texts: [string, string | undefined][] = [
        [`${noun.noun}.tagline`, noun.tagline],
        [`${noun.noun}.rootSummary`, noun.rootSummary],
        [`${noun.noun}.outputNote`, noun.outputNote],
        ...(noun.notes ?? []).map(
          (t, i) => [`${noun.noun}.notes[${i}]`, t] as [string, string],
        ),
        ...noun.verbs.flatMap(
          (v) =>
            [
              [`${noun.noun} ${v.verb}.summary`, v.summary],
              ...[...(v.flags ?? []), ...(v.bools ?? [])].map(
                (f) =>
                  [`${noun.noun} ${v.verb} --${f.name}`, f.description] as [
                    string,
                    string,
                  ],
              ),
            ] as [string, string | undefined][],
        ),
      ];
      for (const [where, text] of texts) {
        if (text && dash.test(text)) problems.push(where);
      }
    }
    expect(problems).toEqual([]);
  });

  it("renders every noun help inside 80 columns", () => {
    const tooWide: string[] = [];
    for (const noun of allNouns()) {
      for (const line of renderNounHelp(noun).split("\n")) {
        if (line.length > 80) tooWide.push(`${noun.noun}: ${line}`);
      }
    }
    expect(tooWide).toEqual([]);
  });

  it("renders the root help inside 80 columns and lists every noun", () => {
    const root = renderRootHelp();
    expect(root.split("\n").filter((l) => l.length > 80)).toEqual([]);
    for (const n of DISPATCHED) {
      expect(root).toContain(n);
    }
  });

  it("builds a usage line that starts with the command it documents", () => {
    for (const noun of allNouns()) {
      for (const v of noun.verbs) {
        const expected = ["homespun", noun.noun, v.verb]
          .filter(Boolean)
          .join(" ");
        expect(usageLine(noun, v).startsWith(expected)).toBe(true);
      }
    }
  });

  it("gives every verb a summary and every flag a description", () => {
    const problems: string[] = [];
    for (const noun of allNouns()) {
      if (!noun.rootSummary.trim())
        problems.push(`${noun.noun}: empty rootSummary`);
      if (noun.verbs.length === 0) problems.push(`${noun.noun}: no verbs`);
      for (const v of noun.verbs) {
        const where = `${noun.noun} ${v.verb}`.trim();
        if (!v.summary.trim()) problems.push(`${where}: empty summary`);
        if (!/[.!?]$/.test(v.summary))
          problems.push(`${where}: summary needs a full stop`);
        for (const f of [...(v.flags ?? []), ...(v.bools ?? [])]) {
          if (!f.description.trim())
            problems.push(`${where} --${f.name}: empty description`);
          if (/[.]$/.test(f.description)) {
            problems.push(
              `${where} --${f.name}: description should not end with a full stop`,
            );
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("exposes nounSpec for each dispatched noun", () => {
    for (const n of DISPATCHED) expect(nounSpec(n)?.noun).toBe(n);
    expect(nounSpec("definitely-not-a-noun")).toBeUndefined();
  });
});
