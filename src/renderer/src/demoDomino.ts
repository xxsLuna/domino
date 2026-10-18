/** Embedded sample used by the welcome screen's "예시로 시작" button. */
export const DEMO_DOMINO_NAME = 'ExampleCRM (예시)'
export const DEMO_DOMINO_TEXT = `; Example CRM — login required, skip login when a token already exists.
[meta]
name = ExampleCRM
logo = https://raw.githubusercontent.com/twitter/twemoji/master/assets/72x72/1f3e0.png
home = main

[auth]
required = true
login_endpoint = http://127.0.0.1:8787/login
token_key = access_token
skip_if_logged_in = true

[api]
base_url = http://127.0.0.1:8787
allow = /login, /leads, /leads/*, /me

[ui]
theme = auto
primary = #4f46e5
style = sharp
density = compact
success = #10b981
warning = #f59e0b
danger = #ef4444

[script]
when not logged_in -> goto login
when logged_in -> goto main
on auth_failed -> goto login
`
