---
"@fnndsc/cumin": patch
---

A listing filtered on this side no longer stops at the first page: a match further on is found.

When CUBE refuses a query, cumin fetches again without the filters and applies them itself, and the walk then judged "last page" by the rows it had kept. A full page of a hundred that kept three, or none, looked like a short page, and everything after it went unread. The walk is now steered by what the server sent: its own word on whether more follows, else the number of rows received, and it moves on by that number, so a server that sends fewer rows than were asked for has none skipped. A page with no rows that says more follow ends the walk and says so in the result (`incomplete`), or fails it when nothing was gathered. `resources_getItems` answers the items of the collection it just fetched; it read the one before.
