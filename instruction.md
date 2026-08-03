# Instructions

Your inbox to Claude. Write what you want done here, one item per block, and it
gets treated exactly as if you had typed it into the chat.

**How it works**

1. You add an entry under *Pending*.
2. Claude reads this file at the start of a task, acts on each entry, then
   **deletes it from this file** once it is done.
3. Anything durable — a decision, a new requirement, a change of direction —
   gets folded into `plan.md` before the entry is deleted, so it is not lost
   when this file is emptied.

Claude only sees this file when it reads it. If you add something while a task
is already running, say "check instruction.md" in the chat.

Entries are instructions, not suggestions. If one is ambiguous or looks
harmful, Claude will ask rather than guess.

---

## Pending

_Nothing right now. Add entries below this line._

---

## Format

Use a heading per item so they are easy to delete individually. Priority and
context are optional but help.

```markdown
### Make the upload button bigger on phones
It is hard to hit one-handed on my iPhone.

### BUG: video scrubbing jumps back
Happens with .mov files in Chrome, not Safari. Priority: high.
```

---

## Recently done

Claude moves a one-line summary here as entries are cleared, newest first, so
you can see what was picked up without digging through git log. Trimmed to the
last 20.

_Nothing yet._
