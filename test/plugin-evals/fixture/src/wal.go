// Package wal is tidewater's write-ahead log: every write is appended here
// before it reaches the memtable.
package wal

import (
	"errors"
	"hash/crc32"
	"os"
	"sync"
)

var castagnoli = crc32.MakeTable(crc32.Castagnoli)

// ErrClosed is returned by Append after Close.
var ErrClosed = errors.New("wal: closed")

// Log is one open write-ahead log directory.
type Log struct {
	mu      sync.Mutex
	dir     string
	segment *os.File
	seq     uint64
	closed  bool
}

// Open opens the log in dir, creating it if needed.
func Open(dir string) (*Log, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(dir+"/000001.log", os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return nil, err
	}
	return &Log{dir: dir, segment: f}, nil
}

// Append writes one record and returns its sequence number.
//
// TODO: group concurrent writers into one write.
// TODO: apply the fsync policy; for now nothing is fsynced unless sync is set.
// TODO: rotate to a new segment when this one is full.
func (l *Log) Append(payload []byte, sync bool) (uint64, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		return 0, ErrClosed
	}
	l.seq++
	rec := encode(l.seq, payload)
	if _, err := l.segment.Write(rec); err != nil {
		return 0, err
	}
	if sync {
		if err := l.segment.Sync(); err != nil {
			return 0, err
		}
	}
	return l.seq, nil
}

// Close syncs and closes the current segment.
func (l *Log) Close() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		return nil
	}
	l.closed = true
	if err := l.segment.Sync(); err != nil {
		return err
	}
	return l.segment.Close()
}

// encode lays out a full record: crc32c, length, type, seqno, payload.
func encode(seq uint64, payload []byte) []byte {
	rec := make([]byte, 17+len(payload))
	putUint32(rec[4:], uint32(len(payload)))
	rec[8] = 1 // full
	putUint64(rec[9:], seq)
	copy(rec[17:], payload)
	putUint32(rec[0:], crc32.Checksum(rec[8:], castagnoli))
	return rec
}

func putUint32(b []byte, v uint32) {
	b[0], b[1], b[2], b[3] = byte(v), byte(v>>8), byte(v>>16), byte(v>>24)
}

func putUint64(b []byte, v uint64) {
	putUint32(b, uint32(v))
	putUint32(b[4:], uint32(v>>32))
}
