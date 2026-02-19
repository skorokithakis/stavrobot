# TODO items

Work on these one at a time. Delete when the user confirms they're done:

* Add authentication. Non-webhook, non-public endpoints should all be authenticated.
  Let's add a password to the config, set by default, and have HTTP basic auth requiring
  that password. Ignore (accept anything as) the username.
