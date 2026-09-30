# Requirements: Pi Subagent Herdr Extension

The extension has to:
- allow to start sub agent (read-only, read-write, ...) jus as the scripts allow
- allow to decide to wait for fininsh directly or to return immediately e.g. after x seconds with the last 50 characters from the console
- allow to get console content 
- allow to wait for a console to 'finish' (--wait) and then return with the last x chars of console
- allow to send text with <enter> to another pane
- allow to send -interrupt- to another pane (depending on the agent this is handed over as CTRL-D for pi - this is the only supported)
- allow to list all panes within the same herdr-space (including names and status)
- list herdr-spaces
- close a pane

We need to gather information in a way so that the behaviour and the caveats of using those tools the agents had can be learned and we can address this in the extension!