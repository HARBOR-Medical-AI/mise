---
"@fnndsc/argus": patch
---

Every gather in the PACS pane names its level: GATHER ALL, GATHER PATIENT, GATHER STUDY, GATHER SERIES.

The frame's set gather read `GATHER 11` beside a row's `GATHER`, which read as two different gathers; it now reads GATHER ALL (GATHER ALL SHOWN under a filter) and keeps the count on its title, as PULL ALL does. A series row's gather reads GATHER SERIES, a study row's GATHER STUDY, and a patient row is offered GATHER PATIENT, which gathers every series of theirs the cohort can name and says in one note what it took and what it could not.
