# tidewater

An embedded key-value storage library for Go: a log-structured merge tree with a
write-ahead log, leveled compaction and optional leader-follower replication.

    db, err := tidewater.Open("data", &tidewater.Options{})
