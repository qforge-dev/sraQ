import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

type TaskRecord = {
  id: string;
  summary: string;
  last_update: string;
};

type GenerationResult = {
  user: string;
  tasks: TaskRecord[];
  reasoning: string;
  final: string;
};

type DatasetRow = {
  developer: string;
  tasks: TaskRecord[];
  user: string;
  reasoning: string;
  final: string;
  messages: Array<{
    content: string;
    role: "system" | "user" | "assistant";
    thinking: string | null;
  }>;
};

type ActionKind =
  | "reply"
  | "start_task"
  | "update_task"
  | "cancel_task"
  | "noop";

type MessageStyle = {
  name: string;
  description: string;
  shortHint: string;
};

type PartitionConfig = {
  name: "train" | "test";
  perAction: number;
  output: string;
};

const MODEL = process.env.GPT_MODEL ?? "gpt-5";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DEFAULT_ROWS = 1000;

if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY environment variable");
  process.exit(1);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const developerPromptPath = join(__dirname, "intent_system_prompt.md");

const DEVELOPERS_PROMPT = (await readFile(developerPromptPath, "utf8")).trim();

const ACTION_GUIDANCE: Record<
  ActionKind,
  {
    validation: (final: string, tasks: TaskRecord[]) => boolean;
    prompt: string;
  }
> = {
  reply: {
    validation: (final) => final.startsWith("reply(") && final.endsWith(")"),
    prompt:
      "Provide a concise assistant intent that directly addresses the user and does not alter existing tasks. Ensure the final string is exactly in the form reply(...).",
  },
  start_task: {
    validation: (final) =>
      final.startsWith("start_task(") && final.endsWith(")"),
    prompt:
      "Open a brand new task distinct from any existing ones. The final string must be start_task(...) with a clear objective for downstream agents.",
  },
  update_task: {
    validation: (final, tasks) => {
      if (!final.startsWith("update_task(") || !final.endsWith(")"))
        return false;
      const inside = final.slice("update_task(".length, -1);
      const commaIndex = inside.indexOf(",");
      if (commaIndex === -1) return false;
      const taskId = inside.slice(0, commaIndex).trim();
      return tasks.some((task) => task.id === taskId);
    },
    prompt:
      "Select one existing task to progress. Reflect new information or next steps. The final string must be update_task(task-id, description). Include the exact task id from the task list.",
  },
  cancel_task: {
    validation: (final, tasks) => {
      if (!final.startsWith("cancel_task(") || !final.endsWith(")"))
        return false;
      const inside = final.slice("cancel_task(".length, -1);
      const commaIndex = inside.indexOf(",");
      if (commaIndex === -1) return false;
      const taskId = inside.slice(0, commaIndex).trim();
      return tasks.some((task) => task.id === taskId);
    },
    prompt:
      "Identify a task that should be stopped and justify the cancellation. The final string must be cancel_task(task-id, reason). Reference an id from the provided tasks.",
  },
  noop: {
    validation: (final) => final === "noop",
    prompt:
      "Choose noop only when multiple in-flight tools are still returning results and no outward action is warranted. The final string must be exactly noop (no punctuation or explanations).",
  },
};

const ACTIONS = Object.keys(ACTION_GUIDANCE) as ActionKind[];

const MESSAGE_STYLES: MessageStyle[] = [
  {
    name: "formal",
    description:
      "Well-structured business English with complete sentences and proper punctuation.",
    shortHint: "formal complete sentences",
  },
  {
    name: "minimal",
    description:
      "Extremely short or telegraphic phrasing (3-6 words), all lowercase, minimal or no punctuation.",
    shortHint: "very short lowercase snippet",
  },
  {
    name: "fragment",
    description:
      "Intentionally unfinished thought, trailing clause, or abruptly cut-off sentence, potentially ending mid-word.",
    shortHint: "incomplete or truncated clause",
  },
  {
    name: "casual",
    description:
      "Relaxed conversational tone with common abbreviations, mixed casing, and light filler words.",
    shortHint: "casual conversational",
  },
  {
    name: "urgent",
    description:
      "Short, urgent-sounding request with imperative language, may omit subjects or punctuation.",
    shortHint: "urgent clipped command",
  },
];

const THEMES: Record<ActionKind, string[]> = {
  reply: [
    "Status reminder on deliverable",
    "Clarifying timeline for project milestone",
    "Responding to user gratitude and quick question",
    "Handling simple factual question",
    "Providing immediate reassurance after partial update",
  ],
  start_task: [
    "New research initiative request",
    "Planning upcoming event logistics",
    "Launching product evaluation",
    "Drafting policy or documentation",
    "Coordinating multi-team rollout",
  ],
  update_task: [
    "Vendor follow-up with new info",
    "Technical issue reproduction progress",
    "Pending approval status advance",
    "Logistics arrangement milestone",
    "Content creation status sync",
  ],
  cancel_task: [
    "User retracts prior request",
    "Task blocked by external decision",
    "Requirements changed midstream",
    "Duplicate initiative spotted",
    "Budget removed for project",
  ],
  noop: [
    "Awaiting signatures and data exports",
    "Multiple investigation tools still running",
    "External vendor automation mid-flight",
    "Coordinated workflow waiting on webhook",
    "Async compliance checks pending",
  ],
};

const basePartitions: PartitionConfig[] = [
  {
    name: "train",
    perAction: DEFAULT_ROWS / ACTIONS.length,
    output: "intent-dataset-train.jsonl",
  },
  {
    name: "test",
    perAction: DEFAULT_ROWS / (ACTIONS.length * 10),
    output: "intent-dataset-test.jsonl",
  },
];

const CONCURRENCY = Number(process.env.GENERATION_CONCURRENCY ?? "100");
const MAX_ATTEMPTS = 4;

const generationSystemPrompt = `You are a data generation assistant creating synthetic supervision examples for an intent-orchestration model. Use the provided developer prompt to stay consistent with reasoning expectations. Output JSON only—no commentary.`;

const staticPrefixMessages = [
  { role: "system" as const, content: generationSystemPrompt },
  {
    role: "system" as const,
    content: `Developer prompt for grounding:\n${DEVELOPERS_PROMPT}`,
  },
];

type Job = {
  action: ActionKind;
  partition: PartitionConfig["name"];
  theme: string;
  index: number;
  globalIndex: number;
  messageStyle: MessageStyle;
};

async function callGpt(jsonPrompt: string): Promise<string> {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        ...staticPrefixMessages,
        { role: "user", content: jsonPrompt },
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `OpenAI request failed: ${response.status} ${response.statusText} — ${errorText}`
    );
  }

  const payload: any = await response.json();
  const content = payload?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("OpenAI response missing content");
  }

  return content;
}

function extractJson(content: string): any {
  const jsonMatch = content.match(/```json\s*([\s\S]*?)```/i);
  const raw = jsonMatch ? jsonMatch[1] : content;
  return JSON.parse(raw);
}

function sanitizeTasks(tasks: any): TaskRecord[] {
  if (!Array.isArray(tasks)) {
    throw new Error("tasks must be an array");
  }

  return tasks.map((task, idx) => {
    if (!task || typeof task !== "object") {
      throw new Error(`Task at index ${idx} is invalid`);
    }

    const id = String(
      task.id ?? task.task_id ?? task.identifier ?? "task-temp"
    ).trim();
    const summary = String(
      task.summary ?? task.title ?? task.description ?? "Pending summary"
    ).trim();
    const lastUpdate = String(
      task.last_update ?? task.lastUpdate ?? task.notes ?? "Awaiting details"
    ).trim();

    if (!id) throw new Error("Task id missing");
    if (!summary) throw new Error("Task summary missing");
    if (!lastUpdate) throw new Error("Task last_update missing");

    return {
      id,
      summary,
      last_update: lastUpdate,
    } satisfies TaskRecord;
  });
}

function validateReasoning(reasoning: any): string {
  const text = String(reasoning ?? "").trim();
  if (!text) {
    throw new Error("Reasoning is empty");
  }

  return text;
}

function validateFinal(
  action: ActionKind,
  final: any,
  tasks: TaskRecord[]
): string {
  const text = String(final ?? "").trim();
  if (!text) {
    throw new Error("Final output is empty");
  }

  const isValid = ACTION_GUIDANCE[action].validation(text, tasks);
  if (!isValid) {
    throw new Error(
      `Final command '${text}' failed validation for action ${action}`
    );
  }

  return text;
}

function ensureTaskCount(action: ActionKind, tasks: TaskRecord[]): void {
  if (tasks.length === 0) {
    throw new Error("At least one ongoing task is required");
  }

  if (
    ["update_task", "cancel_task", "noop"].includes(action) &&
    tasks.length < 2
  ) {
    throw new Error(
      `${action} scenarios must include at least two ongoing tasks`
    );
  }
}

function uniqueTaskIds(tasks: TaskRecord[]): void {
  const seen = new Set<string>();
  for (const task of tasks) {
    if (seen.has(task.id)) {
      throw new Error(`Duplicate task id detected: ${task.id}`);
    }
    seen.add(task.id);
  }
}

function buildDatasetRow(raw: GenerationResult): DatasetRow {
  const { user, tasks, reasoning, final } = raw;
  const tasksJson = JSON.stringify(tasks, null, 2);

  return {
    developer: DEVELOPERS_PROMPT,
    tasks,
    user,
    reasoning,
    final,
    messages: [
      { content: DEVELOPERS_PROMPT, role: "system", thinking: null },
      {
        content: `## Ongoing tasks:\n${tasksJson}`,
        role: "system",
        thinking: null,
      },
      { content: user, role: "user", thinking: null },
      { content: final, role: "assistant", thinking: reasoning },
    ],
  } satisfies DatasetRow;
}

async function generateExample(job: Job): Promise<GenerationResult> {
  const { action, theme, partition, index, messageStyle } = job;
  const actionGuidance = ACTION_GUIDANCE[action].prompt;
  const taskCountHint = ["update_task", "cancel_task", "noop"].includes(action)
    ? "Include 2-3 ongoing tasks so there is meaningful choice."
    : "Include 1-3 ongoing tasks that feel realistic for the theme.";

  const prompt = `Create a synthetic scenario for the ${partition} dataset split. Theme: ${theme}.
The assistant must ultimately choose the intent '${action}'.

Return a JSON object with the following shape:
{
  "user": string,
  "tasks": [ { "id": string, "summary": string, "last_update": string }, ... ],
  "reasoning": string,
  "final": string
}

Constraints:
- The scenario must be written in natural English.
- The user message should reflect the theme and reference previous context when helpful.
- ${taskCountHint}
- Tasks should represent ongoing work only (omit any status field).
- ${actionGuidance}
- Reasoning should be a concise multi-step markdown bullet or numbered list referencing message context, task audit, option comparison, and decision rationale.
- Ensure the reasoning mentions why alternative actions were not chosen.
- The final field must comply exactly with the required format for the specified action.
- For noop scenarios, emphasize multiple in-flight tool updates and why waiting is safest.
- Keep ids in the format task-<number>.
- Avoid mentioning the dataset or that this is synthetic.
- Enforce the user message style: ${messageStyle.name} — ${messageStyle.description}. Include hallmarks such as ${messageStyle.shortHint}. Ensure the intent remains inferable even when phrasing is terse or truncated.`;

  const content = await callGpt(prompt);
  const json = extractJson(content);

  const user = String(json.user ?? "").trim();
  if (!user) throw new Error("User message missing");

  const tasks = sanitizeTasks(json.tasks);
  ensureTaskCount(action, tasks);
  uniqueTaskIds(tasks);

  const reasoning = validateReasoning(json.reasoning);
  const final = validateFinal(action, json.final, tasks);

  return { user, tasks, reasoning, final } satisfies GenerationResult;
}

async function runJobs(jobs: Job[]): Promise<GenerationResult[]> {
  const results: GenerationResult[] = new Array(jobs.length);
  let pointer = 0;
  let completed = 0;
  let lastRender = 0;

  const total = jobs.length;

  const renderProgress = (force = false) => {
    if (!process.stdout.isTTY) return;
    const now = Date.now();
    if (!force && now - lastRender < 120) return;
    lastRender = now;

    const percent = total === 0 ? 1 : completed / total;
    const barLength = 28;
    const filled = Math.round(percent * barLength);
    const bar = `${"#".repeat(filled)}${"-".repeat(
      Math.max(0, barLength - filled)
    )}`;
    const message = `Progress [${bar}] ${(percent * 100).toFixed(
      1
    )}% (${completed}/${total})`;
    process.stdout.write(`\r${message.padEnd(80, " ")}`);
  };

  async function worker(workerId: number) {
    while (true) {
      const currentIndex = pointer++;
      if (currentIndex >= jobs.length) break;
      const job = jobs[currentIndex];

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          const result = await generateExample(job);
          results[currentIndex] = result;
          completed += 1;
          renderProgress();
          break;
        } catch (error) {
          const err = error as Error;
          console.warn(
            `Worker ${workerId} job ${job.partition}-${job.action}#${job.index} attempt ${attempt} failed: ${err.message}`
          );
          if (attempt === MAX_ATTEMPTS) {
            throw err;
          }
          await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
        }
      }
    }
  }

  const workers = Array.from({ length: CONCURRENCY }, (_, workerId) =>
    worker(workerId + 1)
  );
  await Promise.all(workers);

  renderProgress(true);
  if (process.stdout.isTTY) {
    process.stdout.write("\n");
  }

  return results;
}

function shuffle<T>(array: T[]): T[] {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function buildJobs(partition: PartitionConfig, offset: number): Job[] {
  const jobs: Job[] = [];
  let globalIndex = offset;

  ACTIONS.forEach((action) => {
    const themes = THEMES[action];
    for (let i = 0; i < partition.perAction; i++) {
      const theme = themes[i % themes.length];
      const messageStyle = MESSAGE_STYLES[i % MESSAGE_STYLES.length];
      jobs.push({
        action,
        partition: partition.name,
        theme,
        index: i,
        globalIndex,
        messageStyle,
      });
      globalIndex += 1;
    }
  });

  return shuffle(jobs);
}

type MessageRecord = DatasetRow["messages"][number];

function mergeMessages(messages: MessageRecord[]): MessageRecord[] {
  const merged: MessageRecord[] = [];
  for (const current of messages) {
    const last = merged[merged.length - 1];
    if (last && last.role === current.role) {
      last.content = `${last.content}\n${current.content}`.trim();
      if (current.thinking) {
        const combined = last.thinking
          ? `${last.thinking}\n${current.thinking}`.trim()
          : current.thinking.trim();
        last.thinking = combined.length > 0 ? combined : null;
      }
    } else {
      merged.push({
        content: current.content.trim(),
        role: current.role,
        thinking: current.thinking ? current.thinking.trim() || null : null,
      });
    }
  }
  return merged;
}

async function writeJsonl(filePath: string, rows: DatasetRow[]): Promise<void> {
  const jsonl = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
  await Bun.write(filePath, jsonl);
}

async function writeLoraJsonl(
  filePath: string,
  rows: DatasetRow[]
): Promise<void> {
  const jsonl =
    rows
      .map((row) =>
        JSON.stringify({
          messages: mergeMessages(row.messages),
        })
      )
      .join("\n") + "\n";
  await Bun.write(filePath, jsonl);
}

function parseOverride(): PartitionConfig[] {
  const overrideArg = process.argv.find((arg) => arg.startsWith("--rows="));
  if (!overrideArg) return basePartitions;

  const value = Number(overrideArg.split("=")[1]);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("--rows must be a positive number");
  }

  const perActionTotal = Math.floor(value / ACTIONS.length);
  if (perActionTotal <= 0) {
    throw new Error("--rows value too small to cover all action types");
  }

  return [
    {
      name: "custom",
      perAction: perActionTotal,
      output: `intent-dataset-${value}.jsonl`,
    },
  ];
}

async function main() {
  console.log(`Using model ${MODEL} with concurrency ${CONCURRENCY}`);
  const partitions = parseOverride();
  let offset = 0;

  for (const partition of partitions) {
    console.log(
      `\nGenerating ${partition.name} split (${
        partition.perAction * ACTIONS.length
      } rows)`
    );
    const jobs = buildJobs(partition, offset);
    const results = await runJobs(jobs);

    const datasetRows = results.map(buildDatasetRow);
    const outputPath = join(__dirname, partition.output);
    await writeJsonl(outputPath, datasetRows);

    const loraOutputPath = join(
      __dirname,
      partition.output.replace(/\.jsonl$/i, "-lora.jsonl")
    );
    await writeLoraJsonl(loraOutputPath, datasetRows);

    console.log(
      `Wrote ${datasetRows.length} ${partition.name} examples to ${partition.output}`
    );
    console.log(`Wrote ${partition.name} LoRA data to ${loraOutputPath}`);

    offset += results.length;
  }

  console.log("Dataset generation complete.");
}

await main();
