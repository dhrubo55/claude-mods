import { expect, test } from 'claude-code/testing'

import { documentOf, MAX_SUFFIX, MIN_DOCUMENT, pathFor, projectOf, slug, stamp, topicOf } from '../hooks/lib/document'
import { DOC } from './rig'

const BODY = `\n\n## State\n\n${'x'.repeat(MIN_DOCUMENT)}`
const FENCE = '```'

test('documentOf: the document in the answer, or null', () => {
  expect(documentOf(DOC)).toBe(DOC)
  expect(documentOf(DOC.replace(/\n/g, '\r\n'))).toBe(DOC)
  // a sentence before it is dropped
  expect(documentOf(`Here is the handoff.\n\n${DOC}`)).toBe(DOC)
  // an outer markdown fence is taken off; the code blocks inside stay
  const withCode = `${DOC}\n\n${FENCE}bash\nnpm test\n${FENCE}`
  expect(documentOf(`${FENCE}markdown\n${withCode}\n${FENCE}`)).toBe(withCode)
  // a bare code block inside an unfenced document is not an outer fence
  const bare = `${DOC}\n\n${FENCE}\nnpm test\n${FENCE}`
  expect(documentOf(bare)).toBe(bare)
  // a heading and no frontmatter
  const plain = `# Save the handoff${BODY}`
  expect(documentOf(`Done.\n${plain}`)).toBe(plain)
  // a horizontal rule after the heading is not frontmatter
  const ruled = `# Title\n\n---\nNote: a rule, not frontmatter\n---${BODY}`
  expect(documentOf(ruled)).toBe(ruled)
  // not a document
  expect(documentOf('Done. I wrote the handoff to /home/me/x.md')).toBeNull()
  expect(documentOf('# Short\n\ntoo short')).toBeNull()
  expect(documentOf('x'.repeat(MIN_DOCUMENT * 2))).toBeNull()
  expect(documentOf(`---\nnot: closed${BODY}`)).toBeNull()
  expect(documentOf('')).toBeNull()
})

test('topicOf and slug: the file name', () => {
  expect(topicOf(DOC)).toBe('auto-handoff-mod')
  expect(topicOf('---\ntitle: "Fix the Login Bug!"\n---\n# Other')).toBe('fix-the-login-bug')
  expect(topicOf('# Café déjà vu: résumé')).toBe('cafe-deja-vu-resume')
  // a topic with no ASCII letters falls through to the title
  expect(topicOf('---\ntopic: "日本語"\ntitle: "Ünïcode title"\n---')).toBe('unicode-title')
  expect(topicOf("---\ntopic: 'it''s done'\n---")).toBe('it-s-done')
  expect(topicOf('no heading at all')).toBe('handoff')
  // cut at a word boundary, at most 60 characters
  expect(slug('word '.repeat(30))).toBe(Array(12).fill('word').join('-'))
  expect(slug('x'.repeat(80))).toBe('x'.repeat(60))
})

test('projectOf and pathFor: where the file goes', () => {
  expect(projectOf('/home/me/work')).toBe('work')
  expect(projectOf('C:\\Users\\me\\My Project.v2\\')).toBe('my-project-v2')
  expect(projectOf('/')).toBe('project')
  expect(pathFor('/home/me', 'work', 'x', 1)).toBe('/home/me/.claude/handoffs/work/x.md')
  expect(pathFor('/home/me/', 'work', 'x', 2)).toBe('/home/me/.claude/handoffs/work/x-2.md')
  expect(pathFor('C:\\Users\\me', 'work', 'x', 3)).toBe('C:\\Users\\me\\.claude\\handoffs\\work\\x-3.md')
  expect(MAX_SUFFIX).toBe(99)
})

test('stamp: created_at set, replaced, or added with a frontmatter', () => {
  const iso = '2026-10-07T11:28:00.000Z'
  const stamped = stamp(DOC, iso)
  expect(stamped).toBe(`${DOC.replace('---\n', `---\ncreated_at: "${iso}"\n`)}\n`)
  expect(stamp(DOC.replace('topic:', 'created_at: "yesterday"\ntopic:'), iso)).toBe(stamped)
  expect(stamp('# Title\n\nbody', iso)).toBe(`---\ncreated_at: "${iso}"\n---\n\n# Title\n\nbody\n`)
})
