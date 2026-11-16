# This fork

mineflayer-pathfinder as the Harness's Minecraft body runs it: PrismarineJS/mineflayer-pathfinder
with changes that are not upstream.

Base: upstream master at 0eb15c1 (after 2.4.5).

From upstream pull requests that are not merged:

- #399: a search that ran out of time walks its partial path and searches again.
- #386: a path that a `path_update` listener made invalid is dropped.

Own changes, all in `index.js`:

- Placing under a jump (upstream issue #296): the block of a jump-and-place step is placed
  once the feet are above where its top will be (`placingBlock.y + 2.1 < position.y`), and
  the head turns at once (`forceLook: true`).
- A failed equip: when the scaffolding item cannot be taken in hand for a placement, the
  equip lock is released and the path is dropped as `place_error`. Before, the failure was
  ignored with the lock held: no block was placed, jump stayed pressed and nothing ended it.
- A search due in mid-air: a search for a set goal does not start while the body is in the
  air (not on the ground, not in a liquid, not on a ladder or vine, not gliding); it starts
  at the landing, or 30 ticks later when the body is still read as off the ground then. A
  path dropped at the top of a jump was planned from the block the body was passing through.
- A placement under a jump that gets no answer: it is given up after 700 ms and tried again
  with the next jump. The bot waits 5 seconds for the server's answer to a placement; with
  jump held and the placing lock taken, one unanswered placement kept the body jumping in
  place for all of them.
- A new search's results are not used for its first 500 ms. Until then the body goes on by the
  path it had, where the path was dropped for a change of the world (a block near it, a chunk).
  The first slices of a search give the way to the point nearest the goal in a straight line;
  acted on at once, they undid what the finished path had just done (a block placed under a
  jump was dug out again, then placed again, without end).
- GoalLookAtBlock.isEnd compares the middle of the feet cell with the middle of the block: from
  the cell next to the block on the +x or +z side the face turned to the body did not count.
- Swimming through water at one height: a step counts as reached once the body is past its
  point on the way to the step after it. Before, a body that bobbed under the point on the
  tick it crossed the cell turned round and swam back to it.

`package.json`: vec3 `>=0.1.10 <0.3.0`, so the pathfinder uses the Vec3 class of the bot it
is loaded into.
