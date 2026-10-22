# Restart helper — deliberately does NOT restart anything.
#
# This file used to kill and relaunch the app. It caused three failures and is now
# retired. What actually happened:
#
#  1. `CloseMainWindow` closes the window but the app keeps running in the tray, so
#     "graceful close" never terminates it. Waiting on window handles therefore
#     reports success while six processes are still alive.
#  2. Killing them is what produces the "dsh desktop host exited with 4294967295"
#     dialog: the desktop supervises the host child and treats an unexpected exit as
#     a crash. Closing that dialog quits the app.
#  3. The script itself was launched from the harness, so it is a child of the host
#     process it was trying to kill. Killing the host killed the script mid-loop —
#     which is why one run killed exactly one process, stopped logging, and left the
#     old build serving while the log claimed a relaunch.
#
# So restarting is the user's action, and verifying that it worked is a measurement:
#
#   node scripts/check-running-build.mjs <port>
#
# That compares the build timestamps with the serving process's start time and probes
# the plugin's routes, so "did the restart take effect" stops being a guess.

$ErrorActionPreference = 'Continue'

Write-Host 'This helper no longer kills or relaunches DSH Desktop. Why, in short:'
Write-Host '  - closing the window only hides the app to the tray, so nothing exits;'
Write-Host '  - force-killing the host shows a "host exited" crash dialog;'
Write-Host '  - a script launched from the harness dies with the host it kills.'
Write-Host ''
Write-Host 'To pick up a new build:'
Write-Host '  1. quit DSH Desktop from the tray icon (or its menu), then start it again;'
Write-Host '  2. verify with:  node scripts/check-running-build.mjs <gui-port>'
Write-Host ''
Write-Host 'That prints the build time, the serving process start time, and whether'
Write-Host '/task-atlas/state and /task-atlas/events actually answer.'
