/**
 * Flight-recorder — per-run bundle emitter.
 *
 * Every eval run produces a bundle at `eval/reports/YYYY-MM-DD-<cat>-<adapter>-<run>/`
 * with up to 6 artifacts:
 *
 *   transcript.md       — full tool-call + model-call + timing trace
 *   brain-export.json   — final brain state (pages, links, timeline, tags) [optional per adapter]
 *   entity-graph.json   — nodes + edges for backlink F1 scoring [optional per adapter]
 *   citations.json      — claims → source refs (or flagged unsupported) [agent Cats only]
 *   scorecard.json      — metrics + tolerance bands + reproducibility config card
 *   judge-notes.md      — judge rationale per rubric task [Cat 5/8/9 only]
 *
 * Adapters opt into brain-export / entity-graph / citations by implementing
 * `Adapter.exportState?()`. Adapters that return `null` from that hook get
 * a minimal 3-artifact bundle (transcript + scorecard + judge-notes). This
 * keeps the recorder generic across gbrain and external adapters — no
 * special-casing.
 *
 * Writes are atomic (tmp + rename) and race-safe (incremental -2, -3 suffix
 * on directory collision). Never throws on JSON.stringify — uses a replacer
 * to handle circular references.
 */

import { existsSync, mkdirSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

// ─── Types ────────────────────────────────────────────────────────────

export interface TranscriptTurn {
  turn_index: number;
  kind: 'model_call' | 'tool_call' | 'tool_result' | 'final_answer';
  model_call?: {
    model_id: string;
    input_tokens: number;
    output_tokens: number;
    stop_reason?: string;
  };
  tool_call?: {
    tool_name: string;
    tool_input: Record<string, unknown>;
  };
  tool_result?: {
    tool_name: string;
    content: string;
    truncated: boolean;
    matched_poison_fixture_ids: string[];
  };
  final_answer?: {
    text: string;
    evidence_refs: string[];
  };
}

export interface Transcript {
  schema_version: 1;
  probe_id: string;
  adapter: { name: string; stack_id: string };
  started_at: string;
  ended_at: string;
  turns: TranscriptTurn[];
  total_input_tokens: number;
  total_output_tokens: number;
  elapsed_ms: number;
}

export interface Scorecard {
  schema_version: 1;
  config_card: ScorecardConfigCard;
  cat: number;
  N: 1 | 5 | 10;
  metrics: Record<string, ScoredMetric>;
  probes_total?: number;
  probes_passed?: number;
  probes_partial?: number;
  probes_failed?: number;
  verdict: 'pass' | 'fail' | 'baseline_only';
  total_cost_usd?: number;
  wall_clock_seconds?: number;
}

export interface ScorecardConfigCard {
  brainbench_version: string;
  adapter: { name: string; stack_id: string; gbrain_commit?: string };
  driver_model?: { model_id: string; provider: string; params?: Record<string, unknown> };
  judge_model?: { model_id: string; provider: string };
  embedding_model?: string;
  corpus_sha: string;
  seed: number;
  bun_version?: string;
  node_version?: string;
}

export interface ScoredMetric {
  mean: number;
  tolerance?: number;
  stddev?: number;
  per_run?: number[];
}

/** Optional adapter export hook. Adapters implement when they can. */
export interface AdapterExport {
  pages: Array<{ slug: string; type: string; title: string }>;
  graph: { nodes: Array<{ slug: string }>; edges: Array<{ from: string; to: string; type: string }> };
  citations?: Array<{ claim: string; source_slug: string | null }>;
}

export interface JudgeNote {
  probe_id: string;
  rubric_id?: string;
  verdict: 'pass' | 'partial' | 'fail' | 'judge_failed';
  scores: Array<{ criterion_id: string; score: number; rationale: string }>;
  overall_rationale: string;
}

export interface RunBundle {
  runId: string;
  cat: number;
  adapter: { name: string; stack_id: string };
  /** 1 = smoke, 5 = iteration, 10 = published. */
  N: 1 | 5 | 10;
  /** Full transcript for the run. One transcript per probe; merged if multi-probe. */
  transcripts: Transcript[];
  /** Required. Always emitted. */
  scorecard: Scorecard;
  /** Optional — only if adapter's exportState() returned non-null. */
  brainExport?: AdapterExport;
  /** Optional — for agent Cats (5, 8, 9). */
  judgeNotes?: JudgeNote[];
}

export interface EmitOptions {
  /** Root directory for report bundles. Default `eval/reports`. */
  reportsRoot?: string;
}

export interface EmitResult {
  /** Absolute directory path where the bundle was written. */
  dir: string;
  /** List of filenames emitted into the bundle directory. */
  files: string[];
  /** True if directory collision forced an incremental suffix. */
  collisionRetry: boolean;
}

// ─── Public API ───────────────────────────────────────────────────────

/**
 * Emit a flight-recorder bundle to disk. Non-null adapter state produces the
 * full 6-file bundle; null produces the 3-file fallback. Atomic writes +
 * collision retry.
 */
export function emitBundle(bundle: RunBundle, opts: EmitOptions = {}): EmitResult {
  const reportsRoot = opts.reportsRoot ?? join(process.cwd(), 'eval/reports');
  const baseDir = pickDirectoryName(reportsRoot, bundle);
  const { finalDir, collisionRetry } = ensureUniqueDir(baseDir);

  mkdirSync(finalDir, { recursive: true });

  const files: string[] = [];

  // transcript.md (required)
  const transcriptMd = renderTranscriptsMarkdown(bundle.transcripts);
  atomicWrite(join(finalDir, 'transcript.md'), transcriptMd);
  files.push('transcript.md');

  // scorecard.json (required)
  atomicWrite(join(finalDir, 'scorecard.json'), safeStringify(bundle.scorecard));
  files.push('scorecard.json');

  // judge-notes.md (optional, Cat 5/8/9)
  if (bundle.judgeNotes && bundle.judgeNotes.length > 0) {
    atomicWrite(join(finalDir, 'judge-notes.md'), renderJudgeNotesMarkdown(bundle.judgeNotes));
    files.push('judge-notes.md');
  }

  // Optional adapter-state artifacts (full bundle)
  if (bundle.brainExport) {
    atomicWrite(join(finalDir, 'brain-export.json'), safeStringify(bundle.brainExport));
    files.push('brain-export.json');

    atomicWrite(join(finalDir, 'entity-graph.json'), safeStringify(bundle.brainExport.graph));
    files.push('entity-graph.json');

    if (bundle.brainExport.citations) {
      atomicWrite(join(finalDir, 'citations.json'), safeStringify(bundle.brainExport.citations));
      files.push('citations.json');
    }
  }

  return { dir: finalDir, files, collisionRetry };
}

// ─── Directory naming + collision retry ────────────────────────────────

function pickDirectoryName(reportsRoot: string, bundle: RunBundle): string {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const catLabel = `cat${bundle.cat}`;
  const adapter = sanitizeForPath(bundle.adapter.name);
  const run = sanitizeForPath(bundle.runId);
  return join(reportsRoot, `${date}-${catLabel}-${adapter}-${run}`);
}

function ensureUniqueDir(baseDir: string): { finalDir: string; collisionRetry: boolean } {
  if (!existsSync(baseDir)) return { finalDir: baseDir, collisionRetry: false };
  for (let i = 2; i < 1000; i++) {
    const candidate = `${baseDir}-${i}`;
    if (!existsSync(candidate)) return { finalDir: candidate, collisionRetry: true };
  }
  throw new Error(`recorder: too many collisions for ${baseDir}; bailing`);
}

function sanitizeForPath(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'unnamed';
}

// ─── Atomic write + safe JSON ─────────────────────────────────────────

function atomicWrite(finalPath: string, content: string): void {
  const tmpPath = `${finalPath}.tmp-${process.pid}-${Date.now()}`;
  mkdirSync(dirname(finalPath), { recursive: true });
  writeFileSync(tmpPath, content);
  renameSync(tmpPath, finalPath);
}

/**
 * JSON.stringify with a replacer that handles circular references.
 * Never throws on circular data — replaces with "[Circular]" markers.
 */
export function safeStringify(value: unknown, indent: number = 2): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(
    value,
    function (_key, v) {
      if (v !== null && typeof v === 'object') {
        if (seen.has(v as object)) return '[Circular]';
        seen.add(v as object);
      }
      // Handle typed arrays (Float32Array from embeddings, etc.)
      if (v instanceof Float32Array || v instanceof Float64Array) {
        return Array.from(v as unknown as number[]);
      }
      return v;
    },
    indent,
  );
}

// ─── Markdown rendering ────────────────────────────────────────────────

function renderTranscriptsMarkdown(transcripts: Transcript[]): string {
  const lines: string[] = [];
  lines.push('# BrainBench Flight-Recorder Transcript');
  lines.push('');
  lines.push(`Total probes: ${transcripts.length}`);
  lines.push('');

  for (const t of transcripts) {
    lines.push(`## Probe ${t.probe_id}`);
    lines.push('');
    lines.push(`- **Adapter:** \`${t.adapter.name}\` (${t.adapter.stack_id})`);
    lines.push(`- **Started:** ${t.started_at}`);
    lines.push(`- **Ended:** ${t.ended_at}`);
    lines.push(`- **Elapsed:** ${t.elapsed_ms}ms`);
    lines.push(`- **Tokens:** ${t.total_input_tokens} in / ${t.total_output_tokens} out`);
    lines.push('');

    for (const turn of t.turns) {
      lines.push(`### Turn ${turn.turn_index} — ${turn.kind}`);
      lines.push('');
      if (turn.kind === 'model_call' && turn.model_call) {
        lines.push(`- Model: \`${turn.model_call.model_id}\``);
        lines.push(`- Tokens: ${turn.model_call.input_tokens} in / ${turn.model_call.output_tokens} out`);
        if (turn.model_call.stop_reason) lines.push(`- Stop reason: \`${turn.model_call.stop_reason}\``);
      } else if (turn.kind === 'tool_call' && turn.tool_call) {
        lines.push(`- Tool: \`${turn.tool_call.tool_name}\``);
        lines.push('- Input:');
        lines.push('  ```json');
        lines.push(indentBlock(safeStringify(turn.tool_call.tool_input), '  '));
        lines.push('  ```');
      } else if (turn.kind === 'tool_result' && turn.tool_result) {
        lines.push(`- Tool: \`${turn.tool_result.tool_name}\``);
        if (turn.tool_result.truncated) lines.push('- **TRUNCATED at 32K-token cap**');
        if (turn.tool_result.matched_poison_fixture_ids.length > 0) {
          lines.push(
            `- **Matched poison fixtures:** ${turn.tool_result.matched_poison_fixture_ids.join(', ')}`,
          );
        }
        lines.push('- Content:');
        lines.push('  ```');
        lines.push(indentBlock(turn.tool_result.content, '  '));
        lines.push('  ```');
      } else if (turn.kind === 'final_answer' && turn.final_answer) {
        lines.push('- **Final answer:**');
        lines.push('');
        lines.push(indentBlock(turn.final_answer.text, '> '));
        lines.push('');
        if (turn.final_answer.evidence_refs.length > 0) {
          lines.push(`- Evidence refs: ${turn.final_answer.evidence_refs.map(s => `\`${s}\``).join(', ')}`);
        }
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

function renderJudgeNotesMarkdown(notes: JudgeNote[]): string {
  const lines: string[] = ['# Judge Notes', ''];
  for (const note of notes) {
    lines.push(`## Probe ${note.probe_id}`);
    lines.push('');
    lines.push(`- **Verdict:** ${note.verdict}`);
    if (note.rubric_id) lines.push(`- **Rubric:** ${note.rubric_id}`);
    lines.push('');
    lines.push('### Scores');
    lines.push('');
    for (const s of note.scores) {
      lines.push(`- **${s.criterion_id}:** ${s.score}/5 — ${s.rationale}`);
    }
    lines.push('');
    lines.push('### Rationale');
    lines.push('');
    lines.push(note.overall_rationale);
    lines.push('');
  }
  return lines.join('\n');
}

function indentBlock(s: string, prefix: string): string {
  return s
    .split('\n')
    .map(line => prefix + line)
    .join('\n');
}
