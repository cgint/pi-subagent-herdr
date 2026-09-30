# Requirements: Pi Subagent Herdr Extension

The extension has to:
- R-1) allow to start sub agent (read-only, read-write, ...) jus as the scripts allow
- R-2) allow to decide to wait for fininsh directly or to return immediately e.g. after x seconds with the last 50 characters from the console
- R-3) allow to get console content 
- R-4) allow to wait for a console to 'finish' (--wait) and then return with the last x chars of console
- R-5) allow to send text with <enter> to another pane
- R-6) allow to send an interrupt to another pane using Escape for Pi (the only supported agent). CTRL-D exits Pi; it is not a turn interrupt.
- R-7) allow to list all panes within the same herdr-space (including names and status)
- R-8) list herdr-spaces
- R-9) close a pane
- R-10) in the bottom line the HERDR-PANE-ID has to be displayed if pi is running within a herdr pane

We need to gather information in a way so that the behaviour and the caveats of using those tools the agents had can be learned and we can address this in the extension!