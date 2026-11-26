---
"@fnndsc/cumin": minor
"@fnndsc/menu": patch
"@fnndsc/chili": patch
"@fnndsc/salsa": patch
"@fnndsc/brasa": patch
---

An answer from CUBE is checked before it is used: a missing or mistyped field fails by name, not later. A field a caller reads without looking must be there and be the kind that is read. Until now the adapter handed an answer back as whatever type its caller named, and a missing id or a string where a number is read went on to fail somewhere else, or not at all. A failure says which field of what was wrong (`CUBE answered a feed whose id is missing, where a number is read`) and never prints the value. A list fails whole on its first bad row and names the row: no listing is returned short by rows it does not mention. Data that is absent is still an empty list; data that is there and is not a list is now an error and no longer an empty list.

**Incompatible for callers of three exported functions.** `listData_get`, `itemData_get` and `items_get` each take a second argument, the shape, and take no type argument: `listData_get<Feed>(list)` becomes `listData_get(list, shape_build<Feed>('a feed')(['id', 'number'], ['name', 'string']))`, and `shape_object<T>('a thing')` asks only that each row be an object. `shape_build`, `shape_object`, `shape_nullable`, `ShapeError` and the `Shape` type are exported with them. The old one-argument form does not compile.

In menu, `progressKindSchema` and `progressUnitSchema` are typed as what they yield: the enum or `undefined`. They already parsed an unknown value to `undefined`, while their type claimed the enum.

Fields that CUBE may answer as null are typed so: the optional text and number fields of `PluginInstanceData`, `PluginData`, `ComputeResourceData`, `InstanceParameterData`, `PipelineRecord` and `PACSQueryRecord` are `string | null` or `number | null` where they were `string` or `number`, and each is held to its kind when it is there. A caller that passed one on as `string | undefined` now has to say what null becomes. `plugin info` no longer shows a null title, description, authors, documentation or category. `shape_build` takes only an object's type. A page whose `data` is there and is not a list, a served item with no data, and a list with a hole in it are each refused where they were read as empty or passed over.

A plugin instance, listed or read by itself, is held to its id, its feed's id, its plugin's name and its parent's id; a row without them was handed on as a job with no number. A pipeline is held to what one is before it is kept for a later read. Creating a PACS query fails when CUBE gives no receipt with a numeric id, where it answered a query with no id. A feed note with only a title is read as before. `shape_build` and `shape_object` do not take a list's or a function's type.
