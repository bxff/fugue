// Generate the single-page counterexample review directly from
// test_tombstone_invariance.js.
//
// Usage:
//   node generate_tombstone_diagrams.js
//   node generate_tombstone_diagrams.js \
//     --implementation "My branch=/absolute/path/to/built/index.js"

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

function valuesFor(flag) {
  const values = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && args[i + 1] !== undefined) values.push(args[++i]);
  }
  return values;
}

function valueFor(flag, fallback) {
  return valuesFor(flag).at(-1) ?? fallback;
}

function parseImplementation(value) {
  const split = value.indexOf("=");
  if (split === -1) {
    throw new Error(`Implementation must be LABEL=MODULE, got ${JSON.stringify(value)}`);
  }
  return { label: value.slice(0, split), module: value.slice(split + 1) };
}

const requested = valuesFor("--implementation");
const implementations = requested.length > 0
  ? requested.map(parseImplementation)
  : [
      { label: "Tombstone-transparent FugueMax + splice", module: "fugue-max-simple" },
      { label: "Published FugueMax", module: "fugue-max-canonical", optional: true },
    ];
const outputDir = resolve(here, valueFor("--out", "generated/tombstone-tests"));
const testFile = join(here, "test_tombstone_invariance.js");

function runSuite(implementation) {
  try {
    const stdout = execFileSync(process.execPath, [
      testFile,
      "--json",
      "--module",
      implementation.module,
    ], { cwd: here, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    return { ...implementation, report: JSON.parse(stdout) };
  } catch (error) {
    if (implementation.optional) {
      process.stderr.write(`Skipping optional ${implementation.label}: ${error.message}\n`);
      return null;
    }
    throw error;
  }
}

const reports = implementations.map(runSuite).filter(Boolean);
if (reports.length === 0) throw new Error("No implementation reports were generated");

const canonicalCases = reports[0].report.cases;
for (const implementation of reports.slice(1)) {
  const ids = implementation.report.cases.map((test) => test.id).join(",");
  const expectedIds = canonicalCases.map((test) => test.id).join(",");
  if (ids !== expectedIds) {
    throw new Error(`${implementation.label} has a different test set: ${ids}`);
  }
}

const escapeXml = (value) => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;");

function wrap(text, maxCharacters) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = "";
  for (const word of words) {
    if (line !== "" && `${line} ${word}`.length > maxCharacters) {
      lines.push(line);
      line = word;
    } else {
      line = line === "" ? word : `${line} ${word}`;
    }
  }
  if (line !== "") lines.push(line);
  return lines;
}

function textBlock(text, x, y, options = {}) {
  const {
    width = 80,
    size = 20,
    lineHeight = Math.round(size * 1.35),
    fill = "#172033",
    weight = 400,
    anchor = "start",
    family = "Inter, ui-sans-serif, system-ui, -apple-system, sans-serif",
  } = options;
  const lines = wrap(text, width);
  const spans = lines.map((line, index) =>
    `<tspan x="${x}" dy="${index === 0 ? 0 : lineHeight}">${escapeXml(line)}</tspan>`
  ).join("");
  return {
    svg: `<text x="${x}" y="${y}" fill="${fill}" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}" font-family="${family}">${spans}</text>`,
    height: Math.max(1, lines.length) * lineHeight,
  };
}

function pill(label, x, y, options = {}) {
  const tombstone = label.endsWith("†");
  const special = label === "ROOT" || label === "END";
  const width = Math.max(78, label.length * 17 + 30);
  const fill = tombstone ? "#eef0f3" : special ? "#e8eefb" : "#fff3bf";
  const stroke = tombstone ? "#a7adb7" : special ? "#7493d4" : "#d3a719";
  const decoration = tombstone ? ' text-decoration="line-through"' : "";
  return {
    width,
    svg: `<rect x="${x}" y="${y}" width="${width}" height="44" rx="12" fill="${fill}" stroke="${stroke}" stroke-width="2"/>` +
      `<text x="${x + width / 2}" y="${y + 29}" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="22" font-weight="700" fill="#172033"${decoration}>${escapeXml(label)}</text>`,
  };
}

function stateRow(elements, x, y, availableWidth) {
  const widths = elements.map((value) => Math.max(72, value.length * 16 + 28));
  const total = widths.reduce((sum, value) => sum + value, 0);
  const gap = elements.length > 1
    ? Math.min(58, Math.max(20, (availableWidth - total) / (elements.length - 1)))
    : 0;
  let cursor = x + Math.max(0, (availableWidth - total - gap * (elements.length - 1)) / 2);
  const output = [];
  for (let i = 0; i < elements.length; i++) {
    const rendered = pill(elements[i], cursor, y);
    output.push(rendered.svg);
    cursor += rendered.width;
    if (i < elements.length - 1) {
      output.push(`<line x1="${cursor + 5}" y1="${y + 22}" x2="${cursor + gap - 9}" y2="${y + 22}" stroke="#687386" stroke-width="2.5" marker-end="url(#arrow)"/>`);
      cursor += gap;
    }
  }
  return output.join("");
}

function originRow(origin, x, y, width) {
  const left = pill(origin.lo, x + 20, y);
  const middleX = x + Math.round(width * 0.34);
  const middle = pill(origin.node, middleX, y);
  const rightX = x + Math.round(width * 0.67);
  const right = pill(origin.ro, rightX, y);
  const note = textBlock(origin.note, x + 20, y + 67, {
    width: 75,
    size: 14,
    lineHeight: 18,
    fill: "#596274",
  });
  return [
    left.svg,
    `<text x="${x + 20 + left.width / 2}" y="${y - 8}" text-anchor="middle" font-size="13" font-weight="700" fill="#687386" font-family="Inter, ui-sans-serif, system-ui">LEFT ORIGIN</text>`,
    `<line x1="${x + 30 + left.width}" y1="${y + 22}" x2="${middleX - 12}" y2="${y + 22}" stroke="#2363d1" stroke-width="3" marker-end="url(#arrowBlue)"/>`,
    middle.svg,
    `<line x1="${middleX + middle.width + 10}" y1="${y + 22}" x2="${rightX - 12}" y2="${y + 22}" stroke="#2363d1" stroke-width="3" marker-end="url(#arrowBlue)"/>`,
    right.svg,
    `<text x="${rightX + right.width / 2}" y="${y - 8}" text-anchor="middle" font-size="13" font-weight="700" fill="#687386" font-family="Inter, ui-sans-serif, system-ui">RIGHT ORIGIN</text>`,
    note.svg,
  ].join("");
}

function svgDefinitions() {
  return `<defs>
    <marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L0,6 L9,3 z" fill="#687386"/></marker>
    <marker id="arrowBlue" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L0,6 L9,3 z" fill="#2363d1"/></marker>
    <filter id="shadow" x="-10%" y="-10%" width="120%" height="130%"><feDropShadow dx="0" dy="2" stdDeviation="4" flood-opacity="0.11"/></filter>
  </defs>`;
}

function resultFor(report, id) {
  return report.report.cases.find((test) => test.id === id).result;
}

function detailedResultText(result) {
  return [result.actual, ...(result.details ?? [])].join("  ·  ");
}

const graphColors = ["#ef5e5e", "#0167ff", "#20a36a", "#9a56d6"];

function bareToken(token) {
  return token.endsWith("†") ? token.slice(0, -1) : token;
}

function sequenceWidth(tokens, size = 34) {
  return Math.max(size, tokens.length * size * 0.78);
}

function renderSequence(tokens, centerX, baselineY, options = {}) {
  const size = options.size ?? 34;
  const gap = size * 0.78;
  const width = sequenceWidth(tokens, size);
  const startX = centerX - width / 2 + gap / 2;
  const highlight = options.highlight ?? null;
  const output = [];
  if (highlight && highlight.end > highlight.start) {
    const hx = startX + highlight.start * gap - gap * 0.48;
    const hw = (highlight.end - highlight.start) * gap;
    output.push(`<rect x="${hx}" y="${baselineY - size * 0.82}" width="${hw}" height="${size * 1.04}" rx="5" fill="#ffd83d" opacity="0.92"/>`);
  }
  tokens.forEach((token, index) => {
    const x = startX + index * gap;
    const dead = token.endsWith("†");
    const fill = dead ? "#aeb3ba" : (options.fill ?? "#111317");
    output.push(`<text x="${x}" y="${baselineY}" text-anchor="middle" font-family="Avenir Next, Avenir, Inter, sans-serif" font-size="${size}" font-weight="650" fill="${fill}">${escapeXml(bareToken(token))}</text>`);
    output.push(`<line x1="${x - gap * 0.35}" y1="${baselineY + 7}" x2="${x + gap * 0.35}" y2="${baselineY + 7}" stroke="${fill}" stroke-width="2.4" stroke-linecap="round"/>`);
    if (dead) {
      output.push(`<line x1="${x - gap * 0.42}" y1="${baselineY - size * 0.35}" x2="${x + gap * 0.42}" y2="${baselineY - size * 0.35}" stroke="#8d939c" stroke-width="3" stroke-linecap="round"/>`);
      output.push(`<text x="${x + gap * 0.43}" y="${baselineY - size * 0.48}" font-family="Avenir Next, Avenir, sans-serif" font-size="${size * 0.45}" fill="#8d939c">†</text>`);
    }
  });
  return output.join("");
}

function differingRange(values) {
  if (values.length < 2 || values.every((value) => value === values[0])) return null;
  const minimum = Math.min(...values.map((value) => value.length));
  let start = 0;
  while (start < minimum && values.every((value) => value[start] === values[0][start])) start++;
  let suffix = 0;
  while (
    suffix < minimum - start &&
    values.every((value) => value[value.length - 1 - suffix] === values[0][values[0].length - 1 - suffix])
  ) suffix++;
  return values.map((value) => ({ start, end: value.length - suffix }));
}

function observationsFor(implementation, test, worldCount) {
  const result = resultFor(implementation, test.id);
  const observations = result.observations ?? [];
  const indices = test.visual.graph.observationIndices;
  if (indices !== undefined) {
    if (indices.length !== worldCount) {
      throw new Error(`${test.id} has ${worldCount} graph worlds but ${indices.length} observation indices`);
    }
    return indices.map((index) => {
      if (observations[index] === undefined) {
        throw new Error(`${implementation.label}/${test.id} has no observation ${index}`);
      }
      return observations[index];
    });
  }
  if (observations.length === worldCount) return observations;
  if (result.unsupported) {
    return new Array(worldCount).fill(null).map((_, index) => ({
      label: `World ${index + 1}`,
      value: "?",
    }));
  }
  throw new Error(`${implementation.label}/${test.id} has ${observations.length} observations for ${worldCount} graph worlds`);
}

function curve(x1, y1, x2, y2, color, marker = "arrowGraph", opacity = 1, width = 3.2) {
  const bend = Math.max(35, Math.abs(y2 - y1) * 0.42);
  return `<path d="M ${x1} ${y1} C ${x1} ${y1 + bend}, ${x2} ${y2 - bend}, ${x2} ${y2}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" opacity="${opacity}" marker-end="url(#${marker})"/>`;
}

function renderCase(test) {
  const worlds = test.visual.graph.worlds;
  const width = 1600;
  const graphTop = 205;
  const graphBottom = 850;
  const footerTop = 882;
  const height = 1055;
  const margin = 35;
  const worldGap = worlds.length === 1 ? 0 : 34;
  const worldWidth = worlds.length === 1 ? 1120 : (width - margin * 2 - worldGap) / 2;
  const worldStart = worlds.length === 1 ? (width - worldWidth) / 2 : margin;
  const observationSets = reports.map((implementation) =>
    observationsFor(implementation, test, worlds.length)
  );
  const ranges = observationSets.map((observations) =>
    differingRange(observations.map((observation) => observation.value))
  );

  const out = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<defs>
      <marker id="arrowGraph" markerWidth="11" markerHeight="11" refX="9" refY="4" orient="auto"><path d="M0,0 L0,8 L10,4 z" fill="#181a1f"/></marker>
      <marker id="arrowMerge" markerWidth="11" markerHeight="11" refX="9" refY="4" orient="auto"><path d="M0,0 L0,8 L10,4 z" fill="#b8bcc3"/></marker>
      <filter id="softShadow" x="-15%" y="-15%" width="130%" height="140%"><feDropShadow dx="0" dy="2" stdDeviation="3" flood-opacity="0.08"/></filter>
    </defs>`,
    `<rect width="${width}" height="${height}" fill="#ffffff"/>`,
    `<text x="30" y="42" font-family="Avenir Next, Avenir, Inter, sans-serif" font-size="24" font-weight="800" fill="#111317">${escapeXml(test.id)}. ${escapeXml(test.property)}</text>`,
    `<rect x="24" y="70" width="1552" height="${graphBottom - 70}" fill="#f7f8f9"/>`,
    textBlock(test.name, 44, 122, { width: 92, size: 36, lineHeight: 42, weight: 700, family: "Georgia, Times New Roman, serif", fill: "#17191d" }).svg,
    textBlock(test.visual.question, 800, 176, { width: 105, size: 19, lineHeight: 25, anchor: "middle", fill: "#9da1a8", weight: 650 }).svg,
  ];

  if (worlds.length === 2) {
    out.push(`<line x1="800" y1="215" x2="800" y2="822" stroke="#e0e2e6" stroke-width="2"/>`);
  }

  worlds.forEach((world, worldIndex) => {
    const x = worldStart + worldIndex * (worldWidth + worldGap);
    const centerX = x + worldWidth / 2;
    out.push(`<text x="${centerX}" y="${graphTop + 28}" text-anchor="middle" font-family="Avenir Next, Avenir, Inter, sans-serif" font-size="21" font-weight="750" fill="#30343a">${escapeXml(world.title)}</text>`);
    if (world.annotation) {
      out.push(`<text x="${centerX}" y="${graphTop + 60}" text-anchor="middle" font-family="Avenir Next, Avenir, Inter, sans-serif" font-size="16" font-weight="600" fill="#b5b8bd">${escapeXml(world.annotation)}</text>`);
    }

    const sourceY = graphTop + 122;
    const source = world.source.length ? world.source : ["∅"];
    const sourceSpan = Math.min(worldWidth - 180, Math.max(180, source.length * 108));
    const sourcePositions = new Map();
    source.forEach((token, index) => {
      const sx = source.length === 1
        ? centerX
        : centerX - sourceSpan / 2 + index * sourceSpan / (source.length - 1);
      sourcePositions.set(bareToken(token), sx);
      const dead = token.endsWith("†");
      const color = dead ? "#c4c7cc" : graphColors[index % graphColors.length];
      out.push(`<circle cx="${sx}" cy="${sourceY - 12}" r="27" fill="#ffffff" stroke="${color}" stroke-width="4" filter="url(#softShadow)"/>`);
      if (token === "∅") {
        out.push(`<text x="${sx}" y="${sourceY - 3}" text-anchor="middle" font-family="Avenir Next, Avenir, sans-serif" font-size="24" font-weight="650" fill="#8f949c">∅</text>`);
      } else {
        out.push(renderSequence([token], sx, sourceY, { size: 30 }));
      }
    });

    const branchY = graphTop + 300;
    const branchInset = 80;
    const branchPositions = world.branches.map((_, index) =>
      world.branches.length === 1
        ? centerX
        : x + branchInset + index * (worldWidth - branchInset * 2) / (world.branches.length - 1)
    );
    world.branches.forEach((branch, branchIndex) => {
      const bx = branchPositions[branchIndex];
      const edgeSources = branch.from.length
        ? branch.from.map((token) => sourcePositions.get(bareToken(token))).filter((value) => value !== undefined)
        : [centerX];
      edgeSources.forEach((sx) => out.push(curve(sx, sourceY + 24, bx, branchY - 44, "#181a1f")));
      out.push(`<circle cx="${bx}" cy="${branchY - 18}" r="9" fill="${graphColors[branchIndex % graphColors.length]}"/>`);
      out.push(`<text x="${bx}" y="${branchY - 48}" text-anchor="middle" font-family="Avenir Next, Avenir, sans-serif" font-size="15" font-weight="800" fill="${graphColors[branchIndex % graphColors.length]}">PEER ${escapeXml(branch.actor)}</text>`);
      out.push(renderSequence(branch.view, bx, branchY + 20, { size: world.branches.length > 2 ? 27 : 31 }));
      out.push(textBlock(branch.origin, bx, branchY + 55, {
        width: world.branches.length > 2 ? 24 : 34,
        size: 13,
        lineHeight: 17,
        anchor: "middle",
        fill: "#777d86",
        weight: 650,
      }).svg);
    });

    const mergeY = graphTop + 475;
    const junctionY = mergeY - 28;
    branchPositions.forEach((bx) => {
      out.push(curve(bx, branchY + 88, centerX, junctionY, "#b8bcc3", "arrowMerge", 0.95, 3));
    });
    out.push(`<circle cx="${centerX}" cy="${junctionY + 3}" r="6" fill="#b8bcc3"/>`);
    out.push(`<text x="${centerX}" y="${mergeY + 8}" text-anchor="middle" font-family="Avenir Next, Avenir, sans-serif" font-size="13" font-weight="800" letter-spacing="1.4" fill="#a0a5ad">MERGED VISIBLE RESULT</text>`);

    reports.forEach((implementation, implementationIndex) => {
      const result = resultFor(implementation, test.id);
      const observation = observationSets[implementationIndex][worldIndex];
      const resultY = mergeY + 61 + implementationIndex * 78;
      const branchPass = observation.pass ?? result.pass;
      const statusColor = branchPass ? "#16875b" : "#d14238";
      const highlight = branchPass ? null : (ranges[implementationIndex]?.[worldIndex] ?? null);
      out.push(`<text x="${centerX}" y="${resultY - 24}" text-anchor="middle" font-family="Avenir Next, Avenir, sans-serif" font-size="13" font-weight="800" fill="${statusColor}">${escapeXml(implementation.label)} · ${branchPass ? "PASS" : "FAIL"}</text>`);
      out.push(renderSequence([...observation.value], centerX, resultY + 15, { size: 37, highlight }));
    });
  });

  out.push(textBlock(test.catches, 800, footerTop, { width: 122, size: 17, lineHeight: 22, anchor: "middle", fill: "#202329", weight: 800 }).svg);
  out.push(`<rect x="120" y="${footerTop + 29}" width="1360" height="98" rx="8" fill="#fff7c7"/>`);
  out.push(`<text x="800" y="${footerTop + 62}" text-anchor="middle" font-family="Avenir Next, Avenir, sans-serif" font-size="14" font-weight="900" letter-spacing="1.5" fill="#806800">REQUIRED SEMANTICS</text>`);
  out.push(textBlock(test.visual.required, 800, footerTop + 94, { width: 116, size: 19, lineHeight: 25, anchor: "middle", fill: "#29250f", weight: 750 }).svg);
  out.push(`</svg>`);
  return out.join("\n");
}

function renderComparison() {
  // Keep this deliberately plot-like.  Seph's benchmark figures use a plain
  // white field, categorical axes, faint rules, compact marks, and labels
  // placed directly beside the data.  The previous version rendered a stack
  // of dashboard cards, which made comparison much harder than it needed to
  // be and looked unrelated to the source figures.
  const width = 1320;
  const labelWidth = 390;
  const rightMargin = 24;
  const implementationWidth = (width - labelWidth - rightMargin) / reports.length;
  const rowHeight = 66;
  const groupGap = 22;
  const top = 150;
  const groupBreaks = canonicalCases.reduce((count, test, index) => {
    if (index === 0) return count;
    return count + (test.id[0] !== canonicalCases[index - 1].id[0] ? 1 : 0);
  }, 0);
  const height = top + canonicalCases.length * rowHeight + groupBreaks * groupGap + 64;
  const out = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="${width}" height="${height}" fill="#ffffff"/>`,
    `<style>
      text { font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; }
      .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    </style>`,
    `<text x="24" y="36" font-size="24" font-weight="650" fill="#222">Tombstone semantic test comparison</text>`,
    `<text x="24" y="61" font-size="13" fill="#666">Observed semantic variants by executable history. Green holds; red introduces a forbidden variant or breaks a preservation control.</text>`,
    `<text x="24" y="116" font-size="11" font-weight="700" letter-spacing="0.8" fill="#777">CASE / PROPERTY</text>`,
    `<line x1="24" y1="128" x2="${width - rightMargin}" y2="128" stroke="#aaa" stroke-width="1"/>`,
  ];
  reports.forEach((implementation, index) => {
    const x = labelWidth + index * implementationWidth;
    const summary = implementation.report.summary;
    out.push(`<text x="${x + 14}" y="101" font-size="15" font-weight="650" fill="#222">${escapeXml(implementation.label)}</text>`);
    out.push(`<text x="${x + 14}" y="118" font-size="11" fill="#777">${summary.passed} of ${summary.total} properties hold</text>`);
    if (index > 0) {
      out.push(`<line x1="${x}" y1="86" x2="${x}" y2="${height - 42}" stroke="#ddd" stroke-width="1"/>`);
    }
  });
  let y = top;
  canonicalCases.forEach((test, row) => {
    const newGroup = row === 0 || test.id[0] !== canonicalCases[row - 1].id[0];
    if (newGroup && row > 0) y += groupGap;
    if (newGroup) {
      const groupName = test.id[0] === "N" ? "NEUTRALITY"
        : test.id[0] === "S" ? "DELETION STABILITY"
        : "CLUMPING CONTROLS";
      out.push(`<text x="24" y="${y - 7}" font-size="10" font-weight="700" letter-spacing="0.8" fill="#888">${groupName}</text>`);
    }
    const centerY = y + rowHeight / 2;
    out.push(`<line x1="24" y1="${y + rowHeight}" x2="${width - rightMargin}" y2="${y + rowHeight}" stroke="#e5e5e5" stroke-width="1"/>`);
    out.push(`<text x="24" y="${centerY - 5}" font-size="14" font-weight="700" fill="#222">${escapeXml(test.id)}</text>`);
    out.push(textBlock(test.name, 60, centerY - 12, {
      width: 52,
      size: 11.5,
      lineHeight: 13,
      fill: "#333",
      weight: 550,
      family: "Helvetica Neue, Helvetica, Arial, sans-serif",
    }).svg);
    out.push(`<text x="60" y="${centerY + 20}" font-size="10.5" fill="#888">${escapeXml(test.property)}</text>`);
    reports.forEach((implementation, column) => {
      const result = resultFor(implementation, test.id);
      const x = labelWidth + column * implementationWidth + 14;
      const color = result.pass ? "#16844b" : "#d14b42";
      out.push(`<circle cx="${x + 7}" cy="${centerY}" r="7" fill="${color}"/>`);
      out.push(`<text x="${x + 25}" y="${centerY + 4}" font-size="11" font-weight="700" fill="${color}">${result.pass ? "HOLDS" : "VARIANT"}</text>`);
      out.push(`<text class="mono" x="${x + 88}" y="${centerY + 4}" font-size="11.5" fill="#333">${escapeXml(result.actual)}</text>`);
    });
    y += rowHeight;
  });
  out.push(`<circle cx="24" cy="${height - 24}" r="5" fill="#16844b"/><text x="36" y="${height - 20}" font-size="11" fill="#666">property holds</text>`);
  out.push(`<circle cx="134" cy="${height - 24}" r="5" fill="#d14b42"/><text x="146" y="${height - 20}" font-size="11" fill="#666">forbidden variant</text>`);
  out.push(`</svg>`);
  return out.join("\n");
}

function animatedCaseData(test) {
  const worlds = test.visual.graph.worlds;
  const observationSets = reports.map((implementation) =>
    observationsFor(implementation, test, worlds.length)
  );
  const ranges = observationSets.map((observations) =>
    differingRange(observations.map((observation) => observation.value))
  );
  return {
    id: test.id,
    name: test.name,
    role: test.role,
    decision: test.decision,
    evidence: "exact executable trace",
    rationale: test.rationale,
    property: test.property,
    question: test.visual.question,
    catches: test.catches,
    required: test.visual.required,
    worlds: worlds.map((world, worldIndex) => ({
      ...world,
      results: reports.map((implementation, implementationIndex) => {
        const result = resultFor(implementation, test.id);
        const observation = observationSets[implementationIndex][worldIndex];
        const branchPass = observation.pass ?? result.pass;
        return {
          label: implementation.label,
          pass: branchPass,
          status: result.unsupported
            ? "N/A"
            : result.contractDifference && !branchPass
              ? "DIFFERS"
              : undefined,
          value: observation.value,
          highlight: branchPass || result.unsupported
            ? null
            : (ranges[implementationIndex]?.[worldIndex] ?? null),
        };
      }),
    })),
  };
}

function renderAnimatedCase(test, animationVersion) {
  const data = JSON.stringify(animatedCaseData(test)).replaceAll("</", "<\\/");
  const worlds = test.visual.graph.worlds.map((world, index) => `
      <section class="world">
        <h2>${escapeXml(world.title)}</h2>
        ${world.annotation ? `<p class="annotation">${escapeXml(world.annotation)}</p>` : '<p class="annotation">&nbsp;</p>'}
        <canvas data-world="${index}" aria-label="Causal graph for ${escapeXml(world.title)}"></canvas>
      </section>`).join("");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeXml(test.id)} · ${escapeXml(test.name)}</title>
  <script>if (new URLSearchParams(location.search).has('embed')) document.documentElement.classList.add('embedded');</script>
  <style>
    * { box-sizing: border-box; }
    :root { color-scheme: light; font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; }
    body { margin: 0; color: #222; background: white; }
    .page { max-width: 1480px; margin: 0 auto; padding: 22px 24px 18px; }
    header { display: grid; grid-template-columns: 92px minmax(0, 1fr); gap: 18px; align-items: start; padding: 0 0 18px; border-bottom: 1px solid #d9d9d6; }
    .eyebrow { margin: 5px 0 0; color: #666; font-size: 13px; font-weight: 700; line-height: 1.35; letter-spacing: .055em; text-transform: uppercase; }
    h1 { margin: 0; max-width: 1100px; font-size: clamp(27px, 3.2vw, 42px); font-weight: 650; line-height: 1.08; letter-spacing: -.025em; }
    .question { grid-column: 2; margin: -8px 0 0; max-width: 980px; color: #666; font-size: 16px; line-height: 1.45; }
    .worlds { display: grid; grid-template-columns: repeat(${test.visual.graph.worlds.length}, minmax(0, 1fr)); gap: 16px; padding: 18px 0 0; }
    .world { min-width: 0; text-align: center; }
    h2 { margin: 0; font-size: 17px; font-weight: 650; }
    .annotation { min-height: 22px; margin: 4px 8px 8px; color: #888; font-size: 12px; line-height: 1.35; }
    canvas { display: block; width: 100%; aspect-ratio: 1; background: #222; }
    footer { display: grid; grid-template-columns: 1fr 1fr; gap: 28px; margin-top: 18px; padding-top: 15px; border-top: 1px solid #d9d9d6; }
    footer p { margin: 0; font-size: 14px; line-height: 1.5; }
    footer span { display: block; margin-bottom: 4px; color: #777; font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
    .required { font-weight: 650; }
    html.embedded .page { padding: 14px; }
    html.embedded header { display: none; }
    html.embedded .worlds { padding-top: 0; }
    @media (max-width: 850px) {
      .page { padding: 18px 14px; }
      header { grid-template-columns: 1fr; gap: 7px; }
      .question { grid-column: 1; margin: 0; }
      .worlds, footer { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="page">
    <header>
      <p class="eyebrow">${escapeXml(test.id)}<br>${escapeXml(test.property)}</p>
      <h1>${escapeXml(test.name)}</h1>
      <p class="question">${escapeXml(test.visual.question)}</p>
    </header>
    <main class="worlds">${worlds}</main>
    <footer>
      <p class="catches"><span>What this catches</span>${escapeXml(test.catches)}</p>
      <p class="required"><span>Required behavior</span>${escapeXml(test.visual.required)}</p>
    </footer>
  </div>
  <script>window.GRAPH_CASE = ${data};</script>
  <script src="graph-animation.js?v=${animationVersion}"></script>
</body>
</html>`;
}

function renderAnimationScript() {
  // This is a labeled, deterministic adaptation of the normalized-canvas DAG
  // animator embedded at https://braid.org/meeting-118/ancesters.  Operation
  // labels follow the debugging-DAG convention used by Diamond Types' DOT
  // exporters rather than generating random unlabeled histories.
  return `(() => {
  'use strict';
  const COLORS = {
    grey: '#3c3c3c', edge: '#484848', text: '#d7d7da', dim: '#8d8d92',
    red: '#f14c4c', blue: '#3794ff', green: '#35c47a', orange: '#ffad45', purple: '#c586f0',
    shared: '#f586f0', white: '#ffffff', yellow: '#ffd83d', pass: '#35c47a', fail: '#ff5b52'
  };
  const BRANCH_COLORS = [COLORS.red, COLORS.blue, COLORS.green, COLORS.orange];
  const tau = Math.PI * 2;
  const clamp = (value, low = 0, high = 1) => Math.max(low, Math.min(high, value));
  const bare = token => token.endsWith('†') ? token.slice(0, -1) : token;

  function setup(canvas, world, worldIndex) {
    const ctx = canvas.getContext('2d');

    function resize() {
      const dpr = window.devicePixelRatio || 1;
      const size = Math.max(320, Math.floor(canvas.getBoundingClientRect().width));
      canvas.style.height = size + 'px';
      const pixelSize = Math.round(size * dpr);
      if (canvas.width !== pixelSize || canvas.height !== pixelSize) {
        canvas.width = pixelSize;
        canvas.height = pixelSize;
      }
    }

    function schedule() {
      requestAnimationFrame(draw);
    }

    function line(x1, y1, x2, y2, color, width, progress = 1, reverse = false) {
      let ax = x1, ay = y1, bx = x2, by = y2;
      if (reverse) { ax = x2; ay = y2; bx = x1; by = y1; }
      const ex = ax + (bx - ax) * progress;
      const ey = ay + (by - ay) * progress;
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(ex, ey);
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineCap = 'round'; ctx.stroke();
    }

    function circle(x, y, radius, color, scale = 1) {
      ctx.beginPath(); ctx.arc(x, y, radius * scale, 0, tau); ctx.fillStyle = color; ctx.fill();
    }

    function centerText(text, x, y, size, color, weight = 650) {
      ctx.font = weight + ' ' + size + 'px Avenir Next, Avenir, Inter, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = color; ctx.fillText(text, x, y);
    }

    function wrappedText(text, x, y, maxWidth, size, color, lineHeight) {
      ctx.font = '650 ' + size + 'px Avenir Next, Avenir, Inter, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillStyle = color;
      const words = text.split(/\\s+/); const lines = []; let lineText = '';
      for (const word of words) {
        const next = lineText ? lineText + ' ' + word : word;
        if (lineText && ctx.measureText(next).width > maxWidth) { lines.push(lineText); lineText = word; }
        else lineText = next;
      }
      if (lineText) lines.push(lineText);
      lines.slice(0, 3).forEach((value, index) => ctx.fillText(value, x, y + index * lineHeight));
    }

    function tokenString(tokens, x, y, size, color, highlight) {
      const gap = size * 0.74; const start = x - (tokens.length - 1) * gap / 2;
      if (highlight && highlight.end > highlight.start) {
        ctx.fillStyle = COLORS.yellow;
        ctx.fillRect(start + highlight.start * gap - gap * .48, y - size * .58,
          (highlight.end - highlight.start) * gap, size * .92);
      }
      tokens.forEach((token, index) => {
        const tx = start + index * gap; const dead = token.endsWith('†');
        centerText(bare(token), tx, y, size, dead ? '#888b91' : color, 700);
        if (dead) {
          line(tx - gap * .37, y, tx + gap * .37, y, '#999ca2', Math.max(.0014, size * .065));
          centerText('†', tx + gap * .42, y - size * .38, size * .42, '#999ca2', 600);
        }
      });
    }

    function draw(now) {
      resize();
      // Clear in backing-store coordinates before restoring the normalized
      // coordinate system.  This avoids stale pixels when an iframe is first
      // laid out at its intrinsic 300x150 canvas size and then becomes visible.
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#222';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(canvas.width, 0, 0, canvas.height, 0, 0);

      const branchCount = world.branches.length;
      const source = world.source.length ? world.source : ['∅'];
      const sourceY = .15, branchY = .48, mergeY = .76;
      const sourceSpread = Math.min(.72, Math.max(.2, source.length * .15));
      const branchSpread = branchCount === 1 ? 0 : Math.min(.74, Math.max(.42, branchCount * .23));
      const sourcePositions = new Map();
      const sourcePoints = source.map((token, index) => {
        const x = source.length === 1 ? .5 : .5 - sourceSpread / 2 + index * sourceSpread / (source.length - 1);
        sourcePositions.set(bare(token), { x, y: sourceY, token, claims: [] }); return { x, y: sourceY, token, claims: [] };
      });
      const branchPoints = world.branches.map((branch, index) => ({
        x: branchCount === 1 ? .5 : .5 - branchSpread / 2 + index * branchSpread / (branchCount - 1),
        y: branchY, branch, index,
      }));

      const progress = branchPoints.map(() => 1);
      const mergeProgress = 1;

      // Muted history first, exactly like the meeting-118 animator.
      branchPoints.forEach(point => {
        const from = point.branch.from.length ? point.branch.from : [source[0]];
        from.forEach(token => {
          const sourcePoint = sourcePositions.get(bare(token)) || sourcePoints[0];
          line(sourcePoint.x, sourcePoint.y, point.x, point.y, COLORS.edge, .0045);
          sourcePoint.claims.push(point.index);
        });
        line(point.x, point.y, .5, mergeY, COLORS.edge, .0045);
      });

      // Propagate each peer color backward through its ancestry.
      branchPoints.forEach(point => {
        const p = progress[point.index]; if (p <= 0) return;
        const color = BRANCH_COLORS[point.index % BRANCH_COLORS.length];
        const from = point.branch.from.length ? point.branch.from : [source[0]];
        from.forEach(token => {
          const sourcePoint = sourcePositions.get(bare(token)) || sourcePoints[0];
          line(sourcePoint.x, sourcePoint.y, point.x, point.y, color, .0055, p, true);
        });
      });

      // Shared source nodes become magenta once multiple highlighted branches reach them.
      sourcePoints.forEach(point => {
        const active = point.claims.filter(index => progress[index] >= 1);
        const color = active.length > 1 ? COLORS.shared
          : active.length === 1 ? BRANCH_COLORS[active[0] % BRANCH_COLORS.length]
          : COLORS.grey;
        circle(point.x, point.y, .024, color);
        tokenString([point.token], point.x, point.y - .052, .031, COLORS.text, null);
      });

      branchPoints.forEach(point => {
        const p = progress[point.index]; const color = BRANCH_COLORS[point.index % BRANCH_COLORS.length];
        const pop = p > 0 && p < 1 ? 1 + (1 - p) * .25 * Math.sin(Math.sqrt(p) * tau) : 1;
        circle(point.x, point.y, .025, p > 0 ? color : COLORS.grey, pop);
        tokenString(point.branch.view, point.x, point.y + .065, .033, COLORS.text, null);
        wrappedText(point.branch.origin, point.x, point.y + .105, branchCount > 2 ? .24 : .32, .017, COLORS.dim, .021);
      });

      if (mergeProgress > 0) {
        branchPoints.forEach(point => line(point.x, point.y, .5, mergeY,
          BRANCH_COLORS[point.index % BRANCH_COLORS.length], .006, mergeProgress));
      }
      const mergePop = mergeProgress > 0 && mergeProgress < 1
        ? 1 + (1 - mergeProgress) * .35 * Math.sin(Math.sqrt(mergeProgress) * tau) : 1;
      circle(.5, mergeY, .029, mergeProgress >= 1 ? COLORS.white : COLORS.grey, mergePop);
      centerText('MERGE', .5, mergeY - .058, .018, COLORS.dim, 800);

      world.results.forEach((result, index) => {
        const y = mergeY + .075 + index * .085;
        const status = result.status || (result.pass ? 'PASS' : 'FAIL');
        const statusColor = /UNVERIFIED/.test(status) || status.includes('N/A') ? COLORS.dim
          : /PROPOSAL|\bERA\b/.test(status) ? '#d39b2a'
          : /DIFFERS|FORWARD NI|PUBLISHED/.test(status) ? '#4f9cf9'
          : result.pass ? COLORS.pass : COLORS.fail;
        centerText(result.label + ' · ' + status, .5, y - .026, status.length > 9 ? .0135 : .016, statusColor, 800);
        tokenString([...result.value], .5, y + .012, .038, COLORS.white,
          mergeProgress >= 1 ? result.highlight : null);
      });
    }

    schedule();
    window.addEventListener('resize', schedule);
    return () => {
      window.removeEventListener('resize', schedule);
    };
  }

  function setupIntentProof(canvas, graph) {
    const ctx = canvas.getContext('2d');
    const nodes = new Map(graph.nodes.map(node => [node.id, node]));
    const color = name => COLORS[name] || COLORS.grey;

    function resize() {
      const dpr = window.devicePixelRatio || 1;
      const width = Math.max(520, Math.floor(canvas.getBoundingClientRect().width));
      const height = Math.round(width * .79);
      canvas.style.height = height + 'px';
      if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
      }
    }

    function schedule() {
      requestAnimationFrame(draw);
    }

    function centerText(value, x, y, size, fill, weight = 650) {
      ctx.font = weight + ' ' + size + 'px Avenir Next, Avenir, Inter, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = fill; ctx.fillText(value, x, y);
    }

    function wrappedText(value, x, y, maxWidth, size, fill, lineHeight) {
      ctx.font = '650 ' + size + 'px Avenir Next, Avenir, Inter, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillStyle = fill;
      const words = value.split(/\s+/); const lines = []; let current = '';
      words.forEach(word => {
        const next = current ? current + ' ' + word : word;
        if (current && ctx.measureText(next).width > maxWidth) { lines.push(current); current = word; }
        else current = next;
      });
      if (current) lines.push(current);
      lines.slice(0, 2).forEach((line, index) => ctx.fillText(line, x, y + index * lineHeight));
    }

    function tokenString(tokens, x, y, size, fill) {
      const gap = size * .76; const start = x - (tokens.length - 1) * gap / 2;
      tokens.forEach((token, index) => {
        const dead = token.endsWith('†'); const tx = start + index * gap;
        centerText(bare(token), tx, y, size, dead ? '#929297' : fill, 750);
        if (dead) {
          ctx.beginPath(); ctx.moveTo(tx - gap * .36, y); ctx.lineTo(tx + gap * .36, y);
          ctx.strokeStyle = '#9b9ba0'; ctx.lineWidth = .0024; ctx.stroke();
          centerText('†', tx + gap * .42, y - size * .38, size * .42, '#9b9ba0', 650);
        }
      });
    }

    function edgeLine(edge, progress, muted = false) {
      const from = nodes.get(edge.from); const to = nodes.get(edge.to);
      const ex = from.x + (to.x - from.x) * progress;
      const ey = from.y + (to.y - from.y) * progress;
      ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(ex, ey);
      ctx.strokeStyle = muted ? COLORS.edge : color(edge.color);
      ctx.lineWidth = muted ? .0028 : .0048; ctx.lineCap = 'round';
      ctx.setLineDash(edge.dashed && !muted ? [.012, .009] : []); ctx.stroke(); ctx.setLineDash([]);
      if (!muted && edge.label && progress >= .98) {
        const mx = from.x + (to.x - from.x) * .52;
        const my = from.y + (to.y - from.y) * .52;
        const offset = edge.color === 'red' ? -.022 : edge.color === 'blue' ? .022 : .028;
        centerText(edge.label, mx + offset, my, .0125, color(edge.color), 750);
      }
    }

    function stageProgress(stage, elapsed) {
      return 1;
    }

    function draw(now) {
      resize();
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#222'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(canvas.width, 0, 0, canvas.height, 0, 0);

      const elapsed = Infinity;
      graph.edges.forEach(edge => edgeLine(edge, 1, true));
      graph.edges.forEach(edge => edgeLine(edge, stageProgress(edge.stage, elapsed), false));

      graph.nodes.forEach(node => {
        const progress = stageProgress(node.stage, elapsed);
        const active = progress > 0;
        const pop = progress > 0 && progress < 1 ? 1 + (1 - progress) * .28 * Math.sin(Math.sqrt(progress) * tau) : 1;
        ctx.beginPath(); ctx.arc(node.x, node.y, .018 * pop, 0, tau);
        ctx.fillStyle = active ? color(node.color) : COLORS.grey; ctx.fill();
        if (node.id === 'FINAL') {
          centerText('FINAL MERGE', node.x, node.y - .041, .013, COLORS.dim, 800);
          if (active) {
            tokenString(node.state, node.x, node.y + .043, .026, COLORS.text);
            centerText('VALID LINEAR ORDER', node.x, node.y + .082, .013, COLORS.pass, 800);
          }
          return;
        }
        tokenString(node.state, node.x, node.y + .036, .024, COLORS.text);
        wrappedText(node.note, node.x, node.y + .058, .22, .0115, COLORS.dim, .015);
      });

      if (stageProgress(5, elapsed) > .98) {
        centerText('The two meanings stay stable because R chooses its bucket before late M arrives.', .5, .985, .012, COLORS.dim, 650);
      }
    }

    schedule();
    window.addEventListener('resize', schedule);
    return () => {
      window.removeEventListener('resize', schedule);
    };
  }

  let activeCleanups = [];
  window.renderGraphCase = (root = document, graphCase = window.GRAPH_CASE) => {
    activeCleanups.forEach(cleanup => cleanup());
    activeCleanups = [];
    if (!graphCase) return;
    root.querySelectorAll('canvas[data-world]').forEach(canvas => {
      const index = Number(canvas.dataset.world);
      activeCleanups.push(setup(canvas, graphCase.worlds[index], index));
    });
  };
  let proofCleanups = [];
  window.renderProofGraphs = (root, graphCase) => {
    proofCleanups.forEach(cleanup => cleanup());
    proofCleanups = [];
    if (!root || !graphCase) return;
    root.querySelectorAll('canvas[data-intent-proof]').forEach(canvas => {
      proofCleanups.push(setupIntentProof(canvas, graphCase));
    });
  };
  if (window.GRAPH_CASE) window.renderGraphCase(document, window.GRAPH_CASE);
})();
`;
}

function lateROIntentGraphData() {
  return {
    nodes: [
      { id: "AB", x: 0.50, y: 0.07, state: ["A", "B"], note: "shared visible state", stage: 0, color: "shared" },
      { id: "X", x: 0.16, y: 0.22, state: ["A", "X"], note: "X saw only A · RO=end", stage: 1, color: "blue" },
      { id: "M", x: 0.84, y: 0.22, state: ["A", "M", "B"], note: "M uses RO=B · still in flight", stage: 1, color: "red" },
      { id: "O", x: 0.34, y: 0.39, state: ["A", "R", "B†"], note: "ordinary insert after delete · R.RO=end", stage: 2, color: "green" },
      { id: "S", x: 0.66, y: 0.39, state: ["A", "R", "B†"], note: "declared splice · R.RO=B", stage: 2, color: "purple" },
      { id: "OP", x: 0.27, y: 0.61, state: ["A", "R", "X"], note: "ordinary prefix before M", stage: 3, color: "white" },
      { id: "SP", x: 0.73, y: 0.61, state: ["A", "X", "R"], note: "replacement prefix before M", stage: 3, color: "white" },
      { id: "OF", x: 0.27, y: 0.83, state: ["A", "R", "X", "M"], note: "late M is a pure addition", stage: 4, color: "white" },
      { id: "FINAL", x: 0.73, y: 0.83, state: ["A", "X", "M", "R"], note: "late M joins captured B bucket", stage: 4, color: "white" },
    ],
    edges: [
      { from: "AB", to: "X", color: "blue", stage: 1 },
      { from: "AB", to: "M", color: "red", stage: 1 },
      { from: "AB", to: "O", color: "green", stage: 2 },
      { from: "AB", to: "S", color: "purple", stage: 2 },
      { from: "X", to: "OP", color: "blue", stage: 3 },
      { from: "O", to: "OP", color: "green", stage: 3 },
      { from: "X", to: "SP", color: "blue", stage: 3 },
      { from: "S", to: "SP", color: "purple", stage: 3 },
      { from: "OP", to: "OF", color: "green", stage: 4, label: "preserve R<X" },
      { from: "M", to: "OF", color: "red", stage: 4 },
      { from: "SP", to: "FINAL", color: "purple", stage: 4, label: "preserve X<R" },
      { from: "M", to: "FINAL", color: "red", stage: 4 },
    ],
  };
}

function renderIntentBoundaryGraph() {
  const graphCase = lateROIntentGraphData();
  const data = JSON.stringify(graphCase).replaceAll("</", "<\\/");
  return `
    <section class="c3-proof c3-graph-proof" id="intent-proof" hidden>
      <header class="proof-head">
        <p>WHY EXPLICIT REPLACEMENT INTENT IS NECESSARY</p>
        <h2>An in-flight RO=B insertion makes bare delete-then-insert ambiguous.</h2>
        <span>Both branches are stable. They differ because ordinary insertion and replacement intentionally choose different gaps.</span>
        <div class="proof-cast" aria-label="Characters used in the example">
          <i><b>B</b> deleted boundary</i><i><b>X</b> end-bucket witness</i><i><b>M</b> late RO=B reference</i><i><b>R</b> inserted or replacement text</i>
        </div>
        <div class="publication-key"><b>The replacer cannot know whether M exists.</b> Transport timing cannot resolve that missing intent. A splice captures B's live gap before deletion; an ordinary insertion projects through B†.</div>
      </header>
      <div class="unified-proof-graph">
        <h3>Two declared meanings, each stable under late delivery</h3>
        <p>Follow ordinary insertion on the left and declared replacement on the right.</p>
        <canvas data-intent-proof aria-label="Connected graph showing ordinary insertion and explicit replacement under a late right-origin reference"></canvas>
      </div>
      <div class="proof-equation" aria-label="Ordinary insertion and replacement use different stable buckets">
        <span><b>R.RO = end</b><small>ordinary insertion</small></span>
        <i>→</i>
        <strong>A R X M</strong>
        <span><b>R.RO = B</b><small>declared replacement</small></span>
        <i>→</i>
        <strong>A X M R</strong>
      </div>
      <div class="proof-conclusion">
        <b>What D1 establishes</b>
        <span>With identical bare calls and local state, immediate immutable emission cannot infer which meaning was intended while M is unknown. The corrected API carries replacement intent explicitly; handoff, delay, and acknowledgement are never semantic inputs.</span>
      </div>
      <script>window.INTENT_PROOF_CASE = ${data};</script>
    </section>`;
}

function renderIndex(animationVersion) {
  const reviewCases = canonicalCases;
  const semanticGroups = [
    [["N1", "N2", "N3", "N4", "N5"], "Ghost-history neutrality"],
    [["N7"], "Replacement semantics"],
    [["S1", "S2"], "Deletion stability"],
    [["C1", "C2", "C3"], "Structural controls"],
    [["D1"], "Intent boundary"],
  ];
  const semanticNavigation = semanticGroups.map(([ids, label]) => {
    const items = ids.map((id) => reviewCases.find((test) => test.id === id)).filter(Boolean).map((test) => {
      const dots = reports.map((implementation) => {
        const result = resultFor(implementation, test.id);
        const status = result.unsupported ? "na" : result.contractDifference ? "different" : result.pass ? "pass" : "fail";
        const description = result.unsupported ? "not applicable" : result.contractDifference ? "differs from selected contract" : status;
        return `<i class="dot ${status}" title="${escapeXml(implementation.label)}: ${description}"></i>`;
      }).join("");
      return `<a href="#${test.id}" data-case="${test.id}" class="${test.decision}"><b>${test.id}</b><span>${escapeXml(test.name)}</span><em>${dots}</em></a>`;
    }).join("");
    return `<section class="nav-group"><h2>${label}</h2>${items}</section>`;
  }).filter((section) => !section.includes("</h2></section>")).join("");

  const navigation = semanticNavigation;
  const matrixHeader = reviewCases.map((test) => `<th><a href="#${test.id}" data-case="${test.id}" title="${escapeXml(test.role)}">${test.id}</a></th>`).join("");
  const matrixRows = reports.map((implementation) => {
    const cells = reviewCases.map((test) => {
      const result = resultFor(implementation, test.id);
      const status = result.unsupported ? "na" : result.contractDifference ? "different" : result.pass ? "pass" : "fail";
      const description = result.unsupported ? "not applicable" : result.contractDifference ? "differs from selected contract" : status;
      return `<td class="${status}" title="${escapeXml(test.id)}: ${description}">${result.unsupported ? "—" : result.contractDifference ? "≠" : result.pass ? "✓" : "×"}</td>`;
    }).join("");
    const results = reviewCases.map((test) => resultFor(implementation, test.id));
    const passed = results.filter((result) => result.pass).length;
    const failed = results.filter((result) => !result.pass && !result.unsupported && !result.contractDifference).length;
    const unsupported = results.filter((result) => result.unsupported).length;
    const differences = results.filter((result) => result.contractDifference).length;
    const summary = failed === 0 && unsupported === 0 && differences === 0
      ? `${passed}/${results.length}`
      : `${failed} defects · ${unsupported} n/a · ${differences} contract difference`;
    return `<tr><th>${escapeXml(implementation.label)} <small>${summary}</small></th>${cells}</tr>`;
  }).join("");
  const executableCaseData = Object.fromEntries(reviewCases.map((test) => [
    test.id,
    animatedCaseData(test),
  ]));
  const caseData = JSON.stringify(executableCaseData).replaceAll("</", "<\\/");
  const first = reviewCases[0];
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>FugueMax tombstone semantic tests</title>
  <style>
    * { box-sizing: border-box; }
    :root { color-scheme: light; font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; color: #222; background: white; }
    body { margin: 0; }
    a { color: inherit; }
    .masthead { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 24px; align-items: center; max-width: 1560px; margin: 0 auto; padding: 22px 30px 18px; border-bottom: 1px solid #ccc; }
    h1 { margin: 0; font-size: clamp(30px, 4vw, 48px); font-weight: 650; letter-spacing: -.035em; }
    .legend { display: flex; gap: 16px; color: #666; font-size: 12px; white-space: nowrap; }
    .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; }
    .pass { color: #16844b; }
    .fail { color: #c53b32; }
    .dot.pass, td.pass { background: #2ba66a; }
    .dot.fail, td.fail { background: #e15759; }
    .na { color: #777; }
    .dot.na, td.na { background: #aaa; }
    .dot.different, td.different { background: #4f9cf9; }
    main { max-width: 1560px; margin: 0 auto; padding: 20px 30px 40px; }
    .matrix-wrap { overflow-x: auto; margin-bottom: 22px; padding-bottom: 5px; border-bottom: 1px solid #ddd; }
    .matrix { width: 100%; min-width: 650px; border-collapse: separate; border-spacing: 4px 3px; table-layout: fixed; }
    .matrix th, .matrix td { height: 26px; padding: 0; text-align: center; font-size: 12px; }
    .matrix thead th:first-child, .matrix tbody th { width: 210px; text-align: left; }
    .matrix thead a { color: #555; text-decoration: none; }
    .matrix tbody th { font-weight: 600; white-space: nowrap; }
    .matrix small { color: #888; font-weight: 400; }
    .matrix td { color: white; font-weight: 700; }
    .workspace { display: grid; grid-template-columns: 255px minmax(0, 1fr); gap: 28px; align-items: start; }
    nav { position: sticky; top: 14px; max-height: calc(100vh - 28px); overflow-y: auto; padding-right: 5px; }
    .nav-group { margin-bottom: 20px; }
    .nav-group h2 { margin: 0 0 5px; color: #888; font-size: 11px; letter-spacing: .07em; text-transform: uppercase; }
    .nav-group a { display: grid; grid-template-columns: 30px minmax(0, 1fr) auto; gap: 7px; align-items: start; padding: 7px 4px; border-top: 1px solid #e3e3e0; text-decoration: none; }
    .nav-group a:last-child { border-bottom: 1px solid #e3e3e0; }
    .nav-group a:hover, .nav-group a[aria-current="true"] { background: #f1f1ee; }
    .nav-group b { color: #555; font-size: 12px; }
    .nav-group span { font-size: 12px; line-height: 1.25; }
    .nav-group em { display: flex; gap: 4px; padding-top: 3px; }
    .viewer-head { margin-bottom: 10px; }
    .viewer-meta { display: flex; gap: 8px; align-items: center; margin: 0 0 4px; color: #777; font-size: 11px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase; }
    .viewer-meta .role { border: 1px solid #cfcfcb; border-radius: 999px; padding: 2px 7px; color: #555; letter-spacing: .035em; }
    .viewer-head h2 { margin: 0; font-size: 18px; font-weight: 600; }
    .viewer-head .case-question { margin-top: 5px; max-width: 850px; color: #666; font-size: 13px; font-weight: 400; line-height: 1.35; letter-spacing: 0; text-transform: none; }
    .decision-note { margin: 9px 0 0; border-left: 3px solid #2ba66a; padding: 6px 9px; max-width: 1000px; color: #555; background: #f3f7f4; font-size: 12px; line-height: 1.4; }
    .decision-note b { color: #333; text-transform: capitalize; }
    .case-evidence { margin: 5px 0 0; color: #777; font-size: 11px; line-height: 1.35; }
    .case-evidence b { color: #555; text-transform: uppercase; letter-spacing: .05em; }
    .case-figure { border: 1px solid #d8d8d5; padding: 14px; }
    .worlds { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
    .world { min-width: 0; text-align: center; }
    .worlds[data-count="1"] { display: block; }
    .worlds[data-count="1"] .world { width: min(760px, 100%); margin: 0 auto; }
    .world h3 { margin: 0; font-size: 17px; font-weight: 650; }
    .annotation { min-height: 22px; margin: 4px 8px 8px; color: #888; font-size: 12px; line-height: 1.35; }
    canvas { display: block; width: 100%; aspect-ratio: 1; background: #222; }
    .case-notes { display: grid; grid-template-columns: 1fr 1fr; gap: 28px; margin-top: 14px; padding-top: 12px; border-top: 1px solid #d9d9d6; }
    .case-notes p { margin: 0; font-size: 14px; line-height: 1.45; }
    .case-notes span { display: block; margin-bottom: 3px; color: #777; font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
    #case-required { font-weight: 650; }
    .c3-proof { margin-top: 18px; border: 1px solid #d8d8d5; background: #fafaf8; }
    .proof-head { padding: 22px 24px 18px; border-bottom: 1px solid #d8d8d5; }
    .proof-head p { margin: 0 0 5px; color: #c53b32; font-size: 11px; font-weight: 750; letter-spacing: .09em; }
    .proof-head h2 { margin: 0; max-width: 980px; font-size: 24px; line-height: 1.18; letter-spacing: -.015em; }
    .proof-head span { display: block; margin-top: 8px; color: #666; font-size: 14px; }
    .proof-cast { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 15px; }
    .proof-cast i { padding: 5px 9px; border: 1px solid #d8d8d5; border-radius: 999px; background: white; color: #666; font-size: 10px; font-style: normal; }
    .proof-cast b { color: #222; font-size: 11px; }
    .publication-key { max-width: 940px; margin-top: 13px; padding: 9px 11px; border-left: 3px solid #3794ff; background: #f0f5fa; color: #555; font-size: 11px; line-height: 1.45; }
    .publication-key b { color: #2c6092; }
    .proof-sequence { display: flex; justify-content: center; align-items: center; gap: 5px; }
    .proof-sequence i { color: #777; font-size: 12px; font-style: normal; }
    .proof-token { position: relative; display: inline-grid; min-width: 29px; height: 31px; padding: 0 7px; place-items: center; border-bottom: 2px solid currentColor; color: inherit; font-size: 18px; font-weight: 700; }
    .proof-token.dead { color: #999; text-decoration: line-through; }
    .proof-token sup { position: absolute; top: -3px; right: -2px; font-size: 9px; text-decoration: none; }
    .proof-story { padding: 0 24px; }
    .story-step { display: grid; grid-template-columns: 42px minmax(220px, .7fr) minmax(360px, 1.3fr); gap: 18px; align-items: center; min-height: 170px; padding: 22px 0; border-bottom: 1px solid #dededb; }
    .story-step:last-child { border-bottom: 0; }
    .step-number { display: grid; width: 34px; height: 34px; place-items: center; align-self: start; border: 2px solid #333; border-radius: 50%; background: white; font-size: 15px; font-weight: 750; }
    .step-copy h3 { margin: 0 0 7px; font-size: 18px; line-height: 1.2; }
    .step-copy p { margin: 0; color: #5f5f5b; font-size: 13px; line-height: 1.5; }
    .step-visual { min-width: 0; padding: 22px; border-radius: 3px; background: #222; color: #eee; }
    .history-visual { padding-bottom: 14px; }
    .continuation-note { width: 114px; margin: 10px auto 0; border-top: 2px solid #3794ff; color: #78b9f2; text-align: center; }
    .continuation-note span { position: relative; top: 5px; font-size: 10px; font-weight: 650; }
    .deletion-visual { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 20px; align-items: center; }
    .deletion-visual > div { display: flex; gap: 13px; align-items: center; justify-content: center; }
    .change-arrow { color: #aaa; font-size: 10px; font-weight: 700; text-transform: uppercase; }
    .law { display: inline-block; padding: 8px 11px; border-left: 3px solid; font-size: 13px; white-space: nowrap; }
    .law.blue { border-color: #3794ff; color: #78b9f2; }
    .law.green { border-color: #2ba66a; color: #69cf9c; }
    .twin-worlds { display: grid; grid-template-columns: 1fr 112px 1fr; gap: 10px; align-items: stretch; padding: 12px; background: #e9e9e6; color: #333; }
    .twin-worlds > section { padding: 12px; background: white; }
    .twin-worlds small { display: block; margin-bottom: 8px; color: #777; font-size: 9px; font-weight: 750; letter-spacing: .06em; }
    .author-screen { padding: 9px; background: #222; color: white; text-align: center; }
    .author-screen > span { display: block; margin-bottom: 8px; color: #999; font-size: 9px; text-transform: uppercase; }
    .in-flight { display: flex; min-height: 34px; margin-top: 7px; padding: 6px 8px; gap: 6px; align-items: center; border: 1px dashed #bbb; }
    .in-flight b { margin-right: auto; color: #888; font-size: 9px; font-weight: 650; text-transform: uppercase; }
    .flight-token { display: grid; width: 25px; height: 25px; place-items: center; border-radius: 50%; background: #777; color: white; font-size: 11px; font-weight: 750; }
    .flight-token.red { background: #e15759; }
    .same-input { display: flex; flex-direction: column; justify-content: center; color: #555; text-align: center; }
    .same-input::before, .same-input::after { content: ''; height: 1px; background: #aaa; }
    .same-input b { margin-top: 7px; font-size: 10px; text-transform: uppercase; }
    .same-input span { margin: 3px 0 7px; font-size: 10px; line-height: 1.25; }
    .settled-visual { display: flex; gap: 24px; align-items: center; justify-content: center; }
    .final-step { min-height: 295px; }
    .placement-visual { padding: 24px 28px 20px; }
    .demand-label { display: flex; width: 235px; flex-direction: column; line-height: 1.25; }
    .demand-label b { font-size: 10px; letter-spacing: .045em; text-transform: uppercase; }
    .demand-label span { margin-top: 2px; font-size: 12px; }
    .before-label { margin: 0 auto 8px 92px; color: #78b9f2; text-align: center; }
    .after-label { margin: 8px 0 0 auto; color: #ff8789; text-align: center; }
    .placement-line { display: grid; grid-template-columns: 64px 110px 64px 60px 64px 110px; justify-content: center; align-items: center; }
    .line-token { display: grid; width: 52px; height: 52px; place-items: center; border-bottom: 3px solid #eee; color: white; font-size: 26px; font-weight: 750; }
    .demand-gap { display: grid; height: 62px; place-items: center; border: 2px dashed; border-radius: 4px; }
    .demand-gap i { font-size: 20px; font-style: normal; font-weight: 750; }
    .demand-gap.before { border-color: #3794ff; background: #3794ff1c; color: #78b9f2; }
    .demand-gap.after { border-color: #e15759; background: #e157591c; color: #ff8789; }
    .plain-gap { height: 1px; background: #666; }
    .no-place { margin-top: 18px; padding-top: 15px; border-top: 1px solid #555; text-align: center; }
    .no-place strong { display: block; color: white; font-size: 17px; }
    .no-place span { display: block; margin-top: 4px; color: #aaa; font-size: 11px; }
    .proof-conclusion { display: grid; grid-template-columns: 180px minmax(0, 1fr); gap: 18px; margin: 0; padding: 18px 24px; border-top: 1px solid #d8d8d5; background: #edf7f1; font-size: 13px; line-height: 1.5; }
    .proof-conclusion b { color: #16844b; }
    .proof-graph-worlds { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 22px 18px; padding: 22px 24px 26px; }
    .proof-graph-world { min-width: 0; text-align: center; }
    .proof-graph-world h3 { margin: 0; font-size: 17px; font-weight: 650; line-height: 1.25; }
    .proof-graph-world > p { min-height: 37px; margin: 5px 8px 9px; color: #777; font-size: 11px; line-height: 1.4; }
    .proof-graph-world canvas { width: 100%; aspect-ratio: 1; background: #222; }
    .unified-proof-graph { padding: 22px 24px 26px; text-align: center; }
    .unified-proof-graph h3 { margin: 0; font-size: 18px; font-weight: 650; }
    .unified-proof-graph > p { margin: 5px 0 12px; color: #777; font-size: 11px; }
    .unified-proof-graph canvas { display: block; width: 100%; background: #222; }
    .proof-equation { display: flex; gap: 14px; align-items: center; justify-content: center; padding: 20px 24px; border-top: 1px solid #d8d8d5; background: #222; color: white; }
    .proof-equation > span { display: flex; min-width: 115px; flex-direction: column; text-align: center; }
    .proof-equation > span b { color: #69cf9c; font-size: 20px; }
    .proof-equation small { margin-top: 4px; color: #aaa; font-size: 9px; }
    .proof-equation > i { color: #777; font-size: 18px; font-style: normal; }
    .proof-equation > strong { padding: 10px 12px; border: 1px solid #35a56f; color: #69cf9c; font-size: 18px; }
    @media (max-width: 900px) {
      .masthead { grid-template-columns: 1fr; padding: 22px 18px 18px; }
      .masthead > * { min-width: 0; }
      .legend { flex-wrap: wrap; white-space: normal; }
      main { padding: 15px 18px 30px; }
      .workspace { grid-template-columns: 1fr; }
      nav { position: static; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; }
      .nav-group a { grid-template-columns: 28px 1fr; }
      .nav-group span { display: none; }
      .worlds, .case-notes { grid-template-columns: 1fr; }
      .story-step { grid-template-columns: 38px minmax(0, 1fr); }
      .step-visual { grid-column: 1 / -1; }
      .twin-worlds { grid-template-columns: 1fr; }
      .same-input::before, .same-input::after { width: 100%; }
      .proof-graph-worlds { grid-template-columns: 1fr; }
      .proof-equation { flex-wrap: wrap; }
      .proof-conclusion { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <header class="masthead">
    <h1>Tombstone invariance review</h1>
    <div class="legend"><span><i class="dot pass"></i> property holds</span><span><i class="dot fail"></i> published defect</span><span><i class="dot different"></i> contract difference</span><span><i class="dot na"></i> not applicable</span></div>
  </header>
  <main>
    <div class="matrix-wrap">
      <table class="matrix" aria-label="Tombstone semantic requirements by implementation">
        <thead><tr><th>Implementation</th>${matrixHeader}</tr></thead>
        <tbody>${matrixRows}</tbody>
      </table>
    </div>
    <div class="workspace">
      <nav aria-label="Test cases">${navigation}</nav>
      <section class="viewer">
        <div class="viewer-head">
          <div><p class="viewer-meta"><span id="case-property">${escapeXml(first.property)}</span><span class="role" id="case-role">${escapeXml(first.role)}</span></p><h2 id="case-title">${first.id} · ${escapeXml(first.name)}</h2><p class="case-question" id="case-question">${escapeXml(first.visual.question)}</p><p class="decision-note ${first.decision}" id="case-decision"><b>${escapeXml(first.decision)}</b> — ${escapeXml(first.rationale)}</p><p class="case-evidence"><b>Visual evidence</b> <span id="case-evidence">${escapeXml(first.evidence ?? "exact executable trace")}</span></p></div>
        </div>
        <div class="case-figure" id="case-figure">
          <div class="worlds" id="case-worlds"></div>
          <div class="case-notes">
            <p><span>Case</span><b id="case-catches"></b></p>
            <p><span>Expected result</span><b id="case-required"></b></p>
          </div>
        </div>
${renderIntentBoundaryGraph()}
      </section>
    </div>
  </main>
  <script src="graph-animation.js?v=${animationVersion}"></script>
  <script>
    const cases = ${caseData};
    const figure = document.querySelector('#case-figure');
    const worlds = document.querySelector('#case-worlds');
    const html = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
    const select = (id, updateHistory = true) => {
      const entry = cases[id]; if (!entry) return;
      document.querySelector('#case-title').textContent = id + ' · ' + entry.name;
      document.querySelector('#case-property').textContent = entry.property;
      document.querySelector('#case-role').textContent = entry.role;
      document.querySelector('#case-question').textContent = entry.question;
      const decision = document.querySelector('#case-decision');
      decision.className = 'decision-note ' + entry.decision;
      decision.innerHTML = '<b>' + html(entry.decision) + '</b> — ' + html(entry.rationale);
      document.querySelector('#case-evidence').textContent = entry.evidence || 'evidence classification unavailable';
      document.querySelector('#case-catches').textContent = entry.catches;
      document.querySelector('#case-required').textContent = entry.required;
      worlds.dataset.count = String(entry.worlds.length);
      worlds.innerHTML = entry.worlds.map((world, index) =>
        '<section class="world"><h3>' + html(world.title) + '</h3>' +
        '<p class="annotation">' + (world.annotation ? html(world.annotation) : '&nbsp;') + '</p>' +
        '<canvas data-world="' + index + '" aria-label="Causal graph for ' + html(world.title) + '"></canvas></section>'
      ).join('');
      window.GRAPH_CASE = entry;
      window.renderGraphCase(figure, entry);
      const proof = document.querySelector('#intent-proof');
      proof.hidden = id !== 'D1';
      window.renderProofGraphs(proof, id === 'D1' ? window.INTENT_PROOF_CASE : null);
      document.querySelectorAll('[data-case]').forEach(link => link.setAttribute('aria-current', link.dataset.case === id ? 'true' : 'false'));
      if (updateHistory) history.replaceState(null, '', '#' + id);
    };
    document.addEventListener('click', event => {
      const link = event.target.closest('[data-case]'); if (!link) return;
      event.preventDefault(); select(link.dataset.case);
    });
    window.addEventListener('hashchange', () => select(location.hash.slice(1), false));
    select(location.hash.slice(1) || '${first.id}', false);
  </script>
</body>
</html>`;
}

if (existsSync(outputDir)) rmSync(outputDir, { recursive: true });
mkdirSync(outputDir, { recursive: true });
const animationScript = renderAnimationScript();
const animationVersion = createHash("sha256").update(animationScript).digest("hex").slice(0, 12);
writeFileSync(join(outputDir, "graph-animation.js"), animationScript);
writeFileSync(join(outputDir, "index.html"), renderIndex(animationVersion));
execFileSync(process.execPath, ["--check", join(outputDir, "graph-animation.js")]);

process.stdout.write(`Generated the single-page tombstone review in ${outputDir}\n`);
for (const implementation of reports) {
  const retained = implementation.report.cases.filter((test) => test.decision === "retained");
  const passed = retained.filter((test) => test.result.pass).length;
  const failed = retained.filter((test) => !test.result.pass && !test.result.unsupported && !test.result.contractDifference).length;
  const unsupported = retained.filter((test) => test.result.unsupported).length;
  const differences = retained.filter((test) => test.result.contractDifference).length;
  process.stdout.write(`  ${implementation.label}: ${passed} hold, ${failed} fail, ${unsupported} not applicable, ${differences} contract differences\n`);
}
