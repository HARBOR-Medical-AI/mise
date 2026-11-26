---
"@fnndsc/cumin": minor
"@fnndsc/menu": patch
"@fnndsc/chili": patch
---

An answer from CUBE is checked before it is used: a missing or mistyped field fails by name, not later. A field a caller reads without looking must be there and be the kind that is read. Until now the adapter handed an answer back as whatever type its caller named, and a missing id or a string where a number is read went on to fail somewhere else, or not at all. A failure says which field of what was wrong (`CUBE answered a feed whose id is missing, where a number is read`) and never prints the value. A list fails whole on its first bad row and names the row: no listing is returned short by rows it does not mention. Data that is absent is still an empty list; data that is there and is not a list is now an error and no longer an empty list.

**Incompatible for callers of three exported functions.** `listData_get`, `itemData_get` and `items_get` each take a second argument, the shape, and take no type argument: `listData_get<Feed>(list)` becomes `listData_get(list, shape_build<Feed>('a feed')(['id', 'number'], ['name', 'string']))`, and `shape_object<T>('a thing')` asks only that each row be an object. `shape_build`, `shape_object`, `shape_nullable`, `ShapeError` and the `Shape` type are exported with them. The old one-argument form does not compile.

In menu, `progressKindSchema` and `progressUnitSchema` are typed as what they yield: the enum or `undefined`. They already parsed an unknown value to `undefined`, while their type claimed the enum.
