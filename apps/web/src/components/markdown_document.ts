export type MarkdownHeading = {
  id: string;
  level: number;
  line: number;
  title: string;
};

const ATX_HEADING_PATTERN = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
const SETEXT_HEADING_PATTERN = /^ {0,3}(=+|-+)\s*$/;
const FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})/;

export function normalize_math_delimiters(markdown: string): string {
  const lines = markdown.split("\n");
  let fence: string | null = null;
  return lines
    .map((line) => {
      const fence_match = FENCE_PATTERN.exec(line);
      if (fence_match) {
        const marker = fence_match[1]!;
        if (!fence) fence = marker;
        else if (marker[0] === fence[0] && marker.length >= fence.length)
          fence = null;
        return line;
      }
      if (fence) return line;
      const trimmed = line.trim();
      if (trimmed === "\\[" || trimmed === "\\]") {
        return `${line.slice(0, line.indexOf(trimmed))}$$`;
      }
      return replace_inline_math_delimiters(line);
    })
    .join("\n");
}

export function extract_markdown_headings(markdown: string): MarkdownHeading[] {
  const lines = markdown.split("\n");
  const headings: MarkdownHeading[] = [];
  const used_ids = new Map<string, number>();
  let fence: string | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const fence_match = FENCE_PATTERN.exec(line);
    if (fence_match) {
      const marker = fence_match[1]!;
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length)
        fence = null;
      continue;
    }
    if (fence) continue;

    const atx_match = ATX_HEADING_PATTERN.exec(line);
    if (atx_match) {
      headings.push(
        markdown_heading(
          atx_match[2]!,
          atx_match[1]!.length,
          index + 1,
          used_ids,
        ),
      );
      continue;
    }

    const next_line = lines[index + 1];
    const setext_match = next_line
      ? SETEXT_HEADING_PATTERN.exec(next_line)
      : null;
    if (line.trim() && setext_match) {
      headings.push(
        markdown_heading(
          line.trim(),
          setext_match[1]!.startsWith("=") ? 1 : 2,
          index + 1,
          used_ids,
        ),
      );
      index += 1;
    }
  }
  return headings;
}

function replace_inline_math_delimiters(line: string): string {
  let result = "";
  let index = 0;
  let code_delimiter_length = 0;
  while (index < line.length) {
    if (line[index] === "`") {
      let run_length = 1;
      while (line[index + run_length] === "`") run_length += 1;
      if (code_delimiter_length === 0) code_delimiter_length = run_length;
      else if (run_length === code_delimiter_length) code_delimiter_length = 0;
      result += line.slice(index, index + run_length);
      index += run_length;
      continue;
    }
    const delimiter = line.slice(index, index + 2);
    if (
      code_delimiter_length === 0 &&
      (delimiter === "\\(" || delimiter === "\\)")
    ) {
      result += "$";
      index += 2;
      continue;
    }
    result += line[index];
    index += 1;
  }
  return result;
}

function markdown_heading(
  markdown_title: string,
  level: number,
  line: number,
  used_ids: Map<string, number>,
): MarkdownHeading {
  const title = plain_heading_title(markdown_title);
  const slug = markdown_heading_id(title) || "section";
  const occurrence = used_ids.get(slug) ?? 0;
  used_ids.set(slug, occurrence + 1);
  return {
    id: occurrence === 0 ? slug : `${slug}-#${occurrence + 1}`,
    level,
    line,
    title,
  };
}

function plain_heading_title(markdown: string): string {
  return markdown
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*_~]/g, "")
    .replace(/<[^>]+>/g, "")
    .trim();
}

export function markdown_heading_id(title: string): string {
  return title.toLocaleLowerCase().trim().replace(/\s+/g, "-");
}
