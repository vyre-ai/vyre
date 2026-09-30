# projects: MIGRATIONS slot map

`core/store`'s `migrate()` numbers steps by array index in `core/projects/projects.js`'s
`MIGRATIONS` export. Two teams touch this file (projects, federation), so the slot each step
took is tracked here rather than only in commit messages: appending a step anywhere but this
array (as federation's 63af8941 first did, in `core/projects/index.js`) silently collides with
whatever the other team adds next, and the later CREATE then fails with "table exists".

| Slot | Table | Added by |
|---|---|---|
| 0 | `projects_projects` | projects (original module) |
| 1 | `projects_access` | federation, Vyre Drive step 3 (moved out of `index.js` into `projects.js` itself, reviewer's MEDIUM on 63af8941) |
| 2 | `projects_access_seeded` | federation, the one-time auto-seed sentinel (reviewer's MEDIUM 2 on 656b3f79) |

Checked against `main` at write time (sessions' e87f63df, canonical project-id lib): its
`MIGRATIONS` array is still only the slot-0 `projects_projects` entry, so slot 1 is free and this
claim does not collide with anything already merged.

Rule going forward: whoever adds the next step appends to `MIGRATIONS` in `projects.js` itself
(never in `index.js` or any other file) and adds a row to this table before merging.
