# Local test accounts (development only)

Created by `backend/scripts/dev-seed/seed-dev.mjs` against a local backend. The password is shared and
written down here on purpose: these accounts exist only in a local dev database. **Never create them on a
real deployment.**

| Name | Sign in with (email) | Password |
|---|---|---|
| Maya Rahimi (`@uid_maya`) — owns the demo packs | `uid_maya@example.test` | `UiRedesign#2026test` |
| Omid Karimi (`@uid_omid`) | `uid_omid@example.test` | `UiRedesign#2026test` |
| Sara Ahmadi (`@uid_sara`) | `uid_sara@example.test` | `UiRedesign#2026test` |

What's already set up:

- A direct chat between Maya and Omid, and a private group **Weekend trip** with all three.
- Two **public** chats Maya isn't in, to try search → preview → Join:
  - Channel **Family Recipes** (`@family_recipes`), owned by Sara.
  - Group **Book Club** (`@book_club`), owned by Omid.
- Four demo packs, owned by Maya and added to every account:
  - **Family Moments**, 13 stickers. Invite code: `family-moments`.
  - **Animated Faces**, 13 animated emoji. Invite code: `animated-faces`.
  - **Celebrations**, 4 stickers. Invite code: `celebrations`.
  - **Quick Reactions**, 5 animated emoji. Invite code: `quick-reactions`.

Left over from manual testing (not created by the seed): Sara has a profile photo, and she owns a public channel
**Photo test channel** (`@sara_photo_test`).

To test a conversation from both sides, open the app in two browser profiles (or one normal window and one private
window) and sign in as two different people.

Re-seed (safe to repeat):

```bash
API_URL=http://localhost:3097 node backend/scripts/dev-seed/seed-dev.mjs
```
