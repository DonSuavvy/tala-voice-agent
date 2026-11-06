/**
 * The help articles a company pack ships: short answers to general how-to
 * questions, such as what the lights on the modem mean, written to be read
 * aloud. They hold nothing about any account, so a caller needs no
 * verification to hear one.
 *
 * Each is a markdown file that starts with a small front-matter header:
 *
 *     ---
 *     id: modem-lights
 *     title: What the lights on your modem mean
 *     tags: modem, lights, ilaw, pula
 *     ---
 *     The article, in plain words.
 *
 * `id` is a slug and unique, `title` is required, and `tags` is a
 * comma-separated list of the words callers use for the topic, in any
 * language. Nothing else may be in the header, and the article must have
 * text after it. A pack hands over each file's name and text; the name is
 * only for the issues, so every problem says which file to fix. Articles keep
 * the order they are given in.
 */
import { z } from "zod";

export interface HelpArticle {
  id: string;
  title: string;
  tags: string[];
  /** The article's text after its header, trimmed. */
  body: string;
}

/** One file, as a pack hands it over. */
const helpFileSchema = z
  .object({
    /** e.g. `help/modem-lights.md`. */
    file: z.string().min(1),
    markdown: z.string(),
  })
  .strict();

type HelpFile = z.infer<typeof helpFileSchema>;

const headerSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, {
      error: (issue) =>
        `"${String(issue.input)}" is not a slug (lowercase letters, digits and single hyphens)`,
    }),
    title: z.string().min(1),
    tags: z.array(z.string().min(1)).min(1),
  })
  .strict();

/** `---`, the header's lines, `---`, then the article. Either line ending. */
const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/;
const HEADER_LINE = /^([A-Za-z]+)\s*:(.*)$/;

type Issue = { path: (string | number)[]; message: string };

/** The article in one file, or the problems that stop it being read. */
function parseArticle({ file, markdown }: HelpFile): HelpArticle | Issue[] {
  // A byte-order mark, which some editors write first, is not part of the text.
  const parts = FRONT_MATTER.exec(markdown.replace(/^\uFEFF/, ""));
  if (!parts) {
    return [{ path: [], message: `${file} does not start with a "---" front-matter header` }];
  }
  const [, header, rest] = parts;

  const fields: Record<string, string> = {};
  for (const line of header.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const entry = HEADER_LINE.exec(line.trim());
    if (!entry) {
      return [{ path: [], message: `${file}: header line "${line.trim()}" is not "key: value"` }];
    }
    const [, key, value] = entry;
    if (Object.hasOwn(fields, key)) {
      return [{ path: [], message: `${file}: header key "${key}" is given twice` }];
    }
    fields[key] = value.trim();
  }

  const { tags, ...others } = fields;
  const parsed = headerSchema.safeParse({
    ...others,
    ...(tags === undefined ? {} : { tags: tags.split(",").map((tag) => tag.trim()) }),
  });
  if (!parsed.success) {
    return parsed.error.issues.map((issue) => ({
      path: issue.path.map((segment) => (typeof segment === "number" ? segment : String(segment))),
      message: `${file}: ${issue.message}`,
    }));
  }

  const body = rest.trim();
  if (body === "") return [{ path: ["body"], message: `${file} has no text after its header` }];
  return { ...parsed.data, body };
}

/**
 * Every article, in the order given, or one issue per problem, each at the
 * index of its file. The first of two articles with one id is the one kept;
 * the later one is reported.
 */
export const helpArticlesSchema = z.array(helpFileSchema).transform((files, ctx) => {
  const articles: HelpArticle[] = [];
  const ids = new Set<string>();
  files.forEach((file, index) => {
    const article = parseArticle(file);
    if (Array.isArray(article)) {
      for (const issue of article) {
        ctx.addIssue({ code: "custom", path: [index, ...issue.path], message: issue.message });
      }
      return;
    }
    if (ids.has(article.id)) {
      ctx.addIssue({
        code: "custom",
        path: [index, "id"],
        message: `${file.file}: duplicate article id "${article.id}"`,
      });
      return;
    }
    ids.add(article.id);
    articles.push(article);
  });
  return articles;
});
