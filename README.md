# Fitness data

Zackary's training log from Project Z, his personal habit and fitness app: strength sets, load-cell force readings (with raw samples), cardio, timed holds, and body weight.

**Dashboard:** https://z1fire.github.io/fitness-data/

## The data

`database/projectz-fitness.db` is a SQLite database. The Project Z app replaces it after every nightly backup, so it's always the latest copy, and the repository keeps only one commit (old copies don't accumulate in history). Only fitness tables are published.

| Table | What it holds |
|---|---|
| `fitness_exercises`, `fitness_exercise_muscles` | The exercise library: type, movement pattern, equipment, MET, primary and secondary muscles |
| `fitness_sessions` | Workouts (a new one starts after 2 hours without logging) |
| `fitness_iso_efforts`, `fitness_iso_samples` | Load-cell efforts (peak, average, duration, calibration used) and every raw HX711 sample |
| `fitness_sets` | Weighted and bodyweight sets (load in lbs, reps, method) |
| `fitness_cardio` | Duration, distance, calories, carried weight (e.g. a weighted vest) |
| `fitness_holds` | Timed holds without the sensor |
| `fitness_bodyweight` | Weigh-ins |
| `fitness_routines`, `fitness_routine_items` | Planned workouts |
| `fitness_legacy_reps`, `fitness_legacy_samples` | Untouched rows from the app it replaced |
| `export_info` | When this copy was made, and by which app version |

Units are pounds. Times are UTC epoch milliseconds; `local_date` is the training day (a day rolls over at 3 AM).

Quick start in Python:

```python
import sqlite3, urllib.request
urllib.request.urlretrieve("https://z1fire.github.io/fitness-data/database/projectz-fitness.db", "fitness.db")
con = sqlite3.connect("fitness.db")
```

In R: `DBI::dbConnect(RSQLite::SQLite(), "fitness.db")`.

## The site

Plain HTML, CSS, and JavaScript, served by GitHub Pages from `main`. The database is read in the browser with [sql.js](https://github.com/sql-js/sql.js). To change the site, pull first: each upload from the app replaces the repository's single commit.
