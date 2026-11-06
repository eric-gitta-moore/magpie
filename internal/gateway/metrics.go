package gateway

import (
	"net/http"
	"strconv"
	"time"
)

// metricsWindowSeconds is the fixed averaging window, including its current
// one-second bucket. A gateway younger than this still divides by the full window.
const metricsWindowSeconds = 60

// requestBucket counts entry requests in one elapsed second since the first
// request. A reused slot replaces its old count; memory stays bounded at 60 slots.
type requestBucket struct {
	second   int64
	requests int
}

// Metrics is the gateway's present load, independently of the retained trace.
// Requests includes those queued for a concurrency slot; Waiting is that subset.
// QPS counts request starts in the current second and the preceding 59 seconds,
// divided by WindowSeconds. Retries and GET status reads do not start new entries.
type Metrics struct {
	Requests      int     `json:"requests"`
	Waiting       int     `json:"waiting"`
	QPS           float64 `json:"qps"`
	WindowSeconds int     `json:"windowSeconds"`
}

// Metrics reads load at now without asking a provider or changing request
// scheduling. The clock includes sleep without moving backwards, and completed
// requests stay counted until their bucket expires.
func (s *Server) Metrics(now time.Time) *Metrics {
	out := &Metrics{Requests: int(s.inFlight.Load()), WindowSeconds: metricsWindowSeconds}
	s.lanes.mu.Lock()
	for _, ln := range s.lanes.m {
		out.Waiting += len(ln.queue)
	}
	s.lanes.mu.Unlock()

	s.active.mu.Lock()
	if !s.active.rateLast.IsZero() {
		second := s.active.rateSecondAt(now, now.Round(0))
		count := 0
		for _, bucket := range s.active.rateBuckets {
			if bucket.second <= second && second-bucket.second < metricsWindowSeconds {
				count += bucket.requests
			}
		}
		out.QPS = float64(count) / metricsWindowSeconds
	}
	s.active.mu.Unlock()
	return out
}

// rateSecondAt advances a clock whose elapsed time includes system sleep. Some
// systems pause the monotonic clock while asleep, so use the greater positive
// step from the two clocks. A wall-clock rollback never resurrects old buckets.
// Callers hold inflights.mu; the separate readings let tests model clock changes.
func (l *inflights) rateSecondAt(now, wall time.Time) int64 {
	if l.rateLast.IsZero() {
		l.rateLast, l.rateWall = now, wall
		return 0
	}
	step := now.Sub(l.rateLast)
	wallStep := wall.Sub(l.rateWall)
	// Monotonic order identifies an older sample even across a wall-clock rollback.
	if step < 0 {
		return int64(l.rateElapsed / time.Second)
	}
	if wallStep > step {
		step = wallStep
	}
	if step > 0 {
		l.rateElapsed += step
	}
	l.rateLast, l.rateWall = now, wall
	return int64(l.rateElapsed / time.Second)
}

// TracePollWait reads the existing trace wait switch and an optional millisecond
// timeout. Both the GUI and the serving gateway use it: no wait is immediate,
// ordinary long polls keep 25 seconds, and a valid shorter timeout caps the wait.
func TracePollWait(r *http.Request) time.Duration {
	q := r.URL.Query()
	if q.Get("wait") == "" {
		return 0
	}
	wait := 25 * time.Second
	timeout := q.Get("timeout")
	if timeout == "" {
		return wait
	}
	millis, err := strconv.ParseInt(timeout, 10, 64)
	if err != nil || millis <= 0 || millis > wait.Milliseconds() {
		return wait
	}
	return time.Duration(millis) * time.Millisecond
}
