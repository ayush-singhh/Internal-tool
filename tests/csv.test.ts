import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCsv, toCsv, sniffDelimiter, csvField } from "../src/lib/csv.ts";

test("parses plain rows", () => {
  assert.deepEqual(parseCsv("a,b,c\n1,2,3"), [["a","b","c"],["1","2","3"]]);
});

test("ignores a trailing newline", () => {
  assert.deepEqual(parseCsv("a,b\n1,2\n"), [["a","b"],["1","2"]]);
  assert.deepEqual(parseCsv("a,b\r\n1,2\r\n"), [["a","b"],["1","2"]]);
});

test("handles quoted fields with commas, quotes and newlines", () => {
  assert.deepEqual(
    parseCsv('name,note\n"Smith, John","He said ""hi"""\n"multi\nline",x'),
    [["name","note"],["Smith, John",'He said "hi"'],["multi\nline","x"]],
  );
});

test("preserves empty fields", () => {
  assert.deepEqual(parseCsv("a,,c\n,,"), [["a","","c"],["","",""]]);
});

test("strips a UTF-8 BOM from the first header", () => {
  assert.deepEqual(parseCsv("﻿mc,usdot\n123,456")[0], ["mc","usdot"]);
});

test("sniffs the delimiter", () => {
  assert.equal(sniffDelimiter("a,b,c\n1,2,3"), ",");
  assert.equal(sniffDelimiter("a;b;c\n1;2;3"), ";");
  assert.equal(sniffDelimiter("a\tb\tc"), "\t");
  assert.equal(sniffDelimiter('"a,b";c;d'), ";");
});

test("round-trips through toCsv", () => {
  const rows = [["Legal Name","Note"],['Smith, John','say "hi"'],["multi\nline",""]];
  assert.deepEqual(parseCsv(toCsv(rows)), rows);
});

test("neutralises spreadsheet formula injection", () => {
  assert.equal(csvField("=SUM(A1:A9)"), "'=SUM(A1:A9)");
  assert.equal(csvField("+1 (555) 000-1111"), "'+1 (555) 000-1111");
  assert.equal(csvField("-3, please"), '"\'-3, please"');
  assert.equal(csvField("normal"), "normal");
});

test("keeps a lone quoted field intact", () => {
  assert.deepEqual(parseCsv('"only"'), [["only"]]);
});
