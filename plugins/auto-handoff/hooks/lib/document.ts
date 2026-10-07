// The handoff document in a turn's answer, and where the mod saves it. Pure:
// the tests drive these without the engine.

/** An answer shorter than this is a remark, not a handoff document. */
export const MIN_DOCUMENT = 200
/** The mod tries `<topic>.md`, then `<topic>-2.md` up to this suffix. */
export const MAX_SUFFIX = 99
// a frontmatter block that does not close within this many lines is not one
const FRONTMATTER_LINES = 40
const MAX_TOPIC = 60

const OPEN_FENCE = /^```(?:markdown|md)?$/i
const CLOSE_FENCE = /^```$/
const HEADING = /^# \S/
const FIELD = /^[A-Za-z_][\w-]*:/

// the line closing the frontmatter that opens at `start`, or -1
function closeOf(lines: readonly string[], start: number): number {
  if (lines[start]?.trim() !== '---' || !FIELD.test(lines[start + 1] ?? '')) return -1
  const last = Math.min(lines.length - 1, start + FRONTMATTER_LINES)
  for (let i = start + 2; i <= last; i++) if (lines[i]?.trim() === '---') return i
  return -1
}

// the inside of an outer ```markdown fence, when what it holds is the document
function unfence(text: string): string {
  const lines = text.split('\n')
  const open = lines.findIndex(l => OPEN_FENCE.test(l.trim()))
  if (open === -1) return text
  let close = -1
  for (let i = lines.length - 1; i > open; i--) {
    if (CLOSE_FENCE.test(lines[i]?.trim() ?? '')) {
      close = i
      break
    }
  }
  if (close === -1) return text
  const inner = lines.slice(open + 1, close)
  return closeOf(inner, 0) !== -1 || HEADING.test(inner[0] ?? '') ? inner.join('\n') : text
}

/**
 * The handoff document in a turn's answer: from its YAML frontmatter, else
 * from its first `# ` heading, whichever comes first, inside an outer
 * ```markdown fence when there is one. Null when the answer has neither, or
 * what it has is shorter than MIN_DOCUMENT.
 */
export function documentOf(answer: string): string | null {
  const lines = unfence(answer.replace(/\r\n/g, '\n').trim()).split('\n')
  const front = lines.findIndex((_, i) => closeOf(lines, i) !== -1)
  const heading = lines.findIndex(l => HEADING.test(l))
  const starts = [front, heading].filter(i => i !== -1)
  if (starts.length === 0) return null
  const doc = lines.slice(Math.min(...starts)).join('\n').trim()
  return doc.length >= MIN_DOCUMENT ? doc : null
}

function unquote(value: string): string {
  const v = value.trim()
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try {
      return String(JSON.parse(v))
    } catch {
      // not JSON-escaped: drop the quotes only
      return v.slice(1, -1)
    }
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'")
  return v
}

// a frontmatter field of the document, or null
function field(lines: readonly string[], end: number, key: string): string | null {
  for (let i = 1; i < end; i++) {
    const line = lines[i] ?? ''
    if (line.startsWith(`${key}:`)) return unquote(line.slice(key.length + 1))
  }
  return null
}

/** Lowercase ASCII words joined by `-`, cut at a word boundary to `max` characters. */
export function slug(text: string, max = MAX_TOPIC): string {
  const s = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (s.length <= max) return s
  const cut = s.slice(0, max)
  const at = cut.lastIndexOf('-')
  return at > 0 ? cut.slice(0, at) : cut
}

/** The file name's topic: the frontmatter's `topic`, else its `title`, else the first heading; `handoff` when none slugs to anything. */
export function topicOf(doc: string): string {
  const lines = doc.split('\n')
  const end = closeOf(lines, 0)
  const named = end === -1 ? [] : [field(lines, end, 'topic'), field(lines, end, 'title')]
  const heading = lines.find(l => HEADING.test(l))?.slice(2)
  for (const text of [...named, heading]) {
    const s = text ? slug(text) : ''
    if (s) return s
  }
  return 'handoff'
}

/** The project folder: the working directory's basename, lowercased, other characters than `[a-z0-9_-]` replaced by `-`. */
export function projectOf(cwd: string): string {
  const base = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
  return base.toLowerCase().replace(/[^a-z0-9_-]/g, '-') || 'project'
}

/** The n-th file name tried (n from 1): `<home>/.claude/handoffs/<project>/<topic>.md`, then `<topic>-2.md`, … */
export function pathFor(home: string, project: string, topic: string, n: number): string {
  const sep = home.includes('\\') ? '\\' : '/'
  const root = home.replace(/[\\/]+$/, '')
  const name = n === 1 ? `${topic}.md` : `${topic}-${n}.md`
  return [root, '.claude', 'handoffs', project, name].join(sep)
}

/** The file's text: `created_at` set in the frontmatter (one the model wrote is replaced), a frontmatter added when there is none, a final newline. */
export function stamp(doc: string, iso: string): string {
  const lines = doc.split('\n')
  const line = `created_at: "${iso}"`
  const end = closeOf(lines, 0)
  const text =
    end === -1
      ? ['---', line, '---', '', doc].join('\n')
      : [lines[0], line, ...lines.slice(1, end).filter(l => !l.startsWith('created_at:')), ...lines.slice(end)].join('\n')
  return text.endsWith('\n') ? text : `${text}\n`
}
