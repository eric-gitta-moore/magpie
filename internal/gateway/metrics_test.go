package gateway

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/yetone/magpie/internal/provider"
)

// TestRequestMetricsWindow checks expiry and slot reuse with an advanced read
// clock, without waiting a real minute or changing the production clock.
func TestRequestMetricsWindow(t *testing.T) {
	var s Server
	for range 3 {
		_, done := s.active.add(httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil))
		done()
	}
	base := s.active.rateLast
	s.active.rateElapsed = 0 // align the test window exactly at the captured origin
	for _, c := range []struct {
		age  time.Duration
		want float64
	}{
		{0, 3.0 / 60},
		{59*time.Second + 999*time.Millisecond, 3.0 / 60},
		{60 * time.Second, 0},
		{time.Hour, 0},
	} {
		m := s.Metrics(base.Add(c.age))
		if m.QPS != c.want || m.WindowSeconds != 60 || m.Requests != 0 || m.Waiting != 0 {
			t.Fatalf("age %s: %+v, want QPS %v", c.age, m, c.want)
		}
	}
	// Advance the origin by a whole window so a new entry uses the first
	// ring slot again. Its count must replace, not add to, the three expired entries.
	s.active.rateElapsed = 60 * time.Second
	s.active.rateLast, s.active.rateWall = time.Now(), time.Now().Round(0)
	_, done := s.active.add(httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil))
	done()
	if m := s.Metrics(time.Now()); m.QPS != 1.0/60 {
		t.Fatalf("reused bucket: %+v, want one new entry", m)
	}
	var restarted Server
	if m := restarted.Metrics(time.Now()); m.QPS != 0 || m.Requests != 0 || m.WindowSeconds != 60 {
		t.Fatalf("a new gateway retained metrics: %+v", m)
	}
}

// TestRequestMetricsCountEntriesOnce uses the real gateway stack: a failed
// upstream try and its successful fallback form one entry, and status GETs add none.
func TestRequestMetricsCountEntriesOnce(t *testing.T) {
	fresh(t)
	var failed, answered atomic.Int32
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		w.Header().Set("Content-Type", "application/json")
		if strings.HasPrefix(r.URL.Path, "/bad/") {
			failed.Add(1)
			w.WriteHeader(http.StatusInternalServerError)
			io.WriteString(w, `{"error":{"message":"upstream unavailable"}}`)
			return
		}
		answered.Add(1)
		io.WriteString(w, `{"id":"c","object":"chat.completion","model":"m","choices":[{"index":0,"message":{"role":"assistant","content":"hello"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`)
	}))
	defer up.Close()
	for _, p := range []provider.Provider{
		{ID: "bad", Name: "Bad", Key: "k", Chat: up.URL + "/bad/v1", Models: []string{"m"}, Fallback: []string{"good/m"}},
		{ID: "good", Name: "Good", Key: "k", Chat: up.URL + "/good/v1", Models: []string{"m"}},
	} {
		if err := provider.Save(p); err != nil {
			t.Fatal(err)
		}
	}
	s := New()
	gw := httptest.NewServer(s.Handler())
	defer gw.Close()
	res, err := http.Post(gw.URL+"/v1/chat/completions", "application/json", strings.NewReader(`{"model":"bad/m","messages":[{"role":"user","content":"hi"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != 200 || failed.Load() == 0 || answered.Load() != 1 {
		t.Fatalf("fallback: status %d, tries %d/%d, %s", res.StatusCode, failed.Load(), answered.Load(), body)
	}
	for range 3 {
		res, err := http.Get(gw.URL + "/v1/magpie/concurrency")
		if err != nil {
			t.Fatal(err)
		}
		var got struct {
			Requests      int     `json:"requests"`
			QPS           float64 `json:"qps"`
			WindowSeconds int     `json:"windowSeconds"`
		}
		err = json.NewDecoder(res.Body).Decode(&got)
		res.Body.Close()
		if err != nil || got.Requests != 0 || got.QPS != 1.0/60 || got.WindowSeconds != 60 {
			t.Fatalf("entry after fallback and GET: %+v, %v", got, err)
		}
	}
}

// TestRequestMetricsOutliveTheTrace holds more streams than the trace retains,
// proving that counts remain accurate even after unfinished routes are trimmed.
func TestRequestMetricsOutliveTheTrace(t *testing.T) {
	fresh(t)
	var s Server
	started, release := make(chan struct{}, 125), make(chan struct{})
	let := sync.OnceFunc(func() { close(release) })
	var workers sync.WaitGroup
	gw := httptest.NewServer(s.counted(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		rt := s.trace.begin(Route{Agent: "codex", Model: "m", Tries: []Try{}})
		noteRoute(r.Context(), rt)
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, "data: hello\n\n")
		w.(http.Flusher).Flush()
		started <- struct{}{}
		<-release
		s.trace.update(rt, func(r *Route) { r.Done, r.Status = true, 200 })
	})))
	defer func() { let(); workers.Wait(); gw.Close() }()
	failures := make(chan error, 125)
	for range 125 {
		workers.Add(1)
		go func() {
			defer workers.Done()
			res, err := http.Post(gw.URL+"/v1/chat/completions", "application/json", strings.NewReader(`{"model":"m","stream":true}`))
			if err == nil {
				_, err = io.Copy(io.Discard, res.Body)
				res.Body.Close()
			}
			failures <- err
		}()
	}
	deadline := time.NewTimer(10 * time.Second)
	defer deadline.Stop()
	for range 125 {
		select {
		case <-started:
		case err := <-failures:
			t.Fatalf("stream failed before all started: %v", err)
		case <-deadline.C:
			t.Fatal("streams never all started")
		}
	}
	st := s.Trace(t.Context(), 0, 0)
	if len(st.Routes) >= 125 || st.Metrics == nil || st.Metrics.Requests != 125 || st.Metrics.QPS != 125.0/60 {
		t.Fatalf("retained %d routes, metrics %+v, want 125 entries", len(st.Routes), st.Metrics)
	}
	let()
	workers.Wait()
	if m := s.Metrics(time.Now()); m.Requests != 0 || m.QPS != 125.0/60 {
		t.Fatalf("completed streams: %+v", m)
	}
}

// TestTraceMetricsSampledAfterWaiting checks an unchanged trace on timeout and
// cancellation. Load can change independently, and the returned snapshot is current.
func TestTraceMetricsSampledAfterWaiting(t *testing.T) {
	for _, cancelRead := range []bool{false, true} {
		t.Run(map[bool]string{false: "timeout", true: "cancel"}[cancelRead], func(t *testing.T) {
			var s Server
			s.inFlight.Store(1)
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			heard := make(chan TraceState, 1)
			go func() { heard <- s.Trace(ctx, 0, time.Second) }()
			// Wait for the long poll's wake channel, rather than guessing when it began.
			deadline := time.Now().Add(5 * time.Second)
			for {
				s.trace.mu.Lock()
				waiting := s.trace.wake != nil
				s.trace.mu.Unlock()
				if waiting {
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("trace did not start waiting")
				}
				time.Sleep(time.Millisecond)
			}
			s.inFlight.Store(0)
			if cancelRead {
				cancel()
			}
			st := <-heard
			if st.Metrics == nil || st.Metrics.Requests != 0 || st.Seq != 0 {
				t.Fatalf("stale metrics after wait: %+v", st)
			}
		})
	}
}

// TestTracePollWait preserves the default wait and accepts only the supported
// positive millisecond range, with no timeout effect on a non-waiting read.
func TestTracePollWait(t *testing.T) {
	for _, c := range []struct {
		query string
		want  time.Duration
	}{
		{"", 0}, {"?timeout=1000", 0}, {"?wait=1", 25 * time.Second},
		{"?wait=1&timeout=1000", time.Second}, {"?wait=1&timeout=1", time.Millisecond},
		{"?wait=1&timeout=25000", 25 * time.Second}, {"?wait=1&timeout=25001", 25 * time.Second},
		{"?wait=1&timeout=-1", 25 * time.Second}, {"?wait=1&timeout=0", 25 * time.Second},
		{"?wait=1&timeout=bad", 25 * time.Second}, {"?wait=1&timeout=99999999999999999999", 25 * time.Second},
	} {
		if got := TracePollWait(httptest.NewRequest(http.MethodGet, "/api/gateway/trace"+c.query, nil)); got != c.want {
			t.Errorf("%s: %s, want %s", c.query, got, c.want)
		}
	}
}

// TestOwnerTraceMetrics checks the serving-process path and older responses:
// the same timeout goes upstream and a missing metric stays nil, not zero.
func TestOwnerTraceMetrics(t *testing.T) {
	for _, modern := range []bool{true, false} {
		t.Run(map[bool]string{true: "new gateway", false: "old gateway"}[modern], func(t *testing.T) {
			query := make(chan string, 1)
			up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				query <- r.URL.RawQuery
				payload := map[string]any{"object": "trace", "seq": 7, "routes": []Route{}, "pid": 4321, "serves": "serve"}
				if modern {
					payload["metrics"] = Metrics{Requests: 4, Waiting: 1, QPS: 0.25, WindowSeconds: 60}
				}
				json.NewEncoder(w).Encode(payload)
			}))
			defer up.Close()
			t.Setenv("MAGPIE_ADDR", strings.TrimPrefix(up.URL, "http://"))
			st, ok := OwnerTrace(t.Context(), 7, time.Second)
			if !ok {
				t.Fatalf("owner read failed: %+v", st)
			}
			q := <-query
			if !ok || !strings.Contains(q, "timeout=1000") || !strings.Contains(q, "wait=1") {
				t.Fatalf("owner read: ok %v, query %s, state %+v", ok, q, st)
			}
			if modern {
				if st.Metrics == nil || *st.Metrics != (Metrics{Requests: 4, Waiting: 1, QPS: 0.25, WindowSeconds: 60}) {
					t.Fatalf("metrics not carried: %+v", st.Metrics)
				}
			} else if st.Metrics != nil {
				t.Fatalf("missing metrics became known: %+v", st.Metrics)
			}
		})
	}
}

// TestOwnerTraceShortPollLegacyFallback models an older gateway that ignores
// timeout=1000 and holds wait=1 until cancellation. Its immediate snapshot remains
// readable after the short transport timeout instead of making the GUI go offline.
func TestOwnerTraceShortPollLegacyFallback(t *testing.T) {
	var reads atomic.Int32
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reads.Add(1)
		if r.URL.Query().Get("wait") != "" {
			<-r.Context().Done()
			return
		}
		io.WriteString(w, `{"object":"trace","seq":7,"routes":[],"pid":4321,"serves":"serve"}`)
	}))
	defer up.Close()
	t.Setenv("MAGPIE_ADDR", strings.TrimPrefix(up.URL, "http://"))
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	st, ok := OwnerTrace(ctx, 7, time.Second)
	if !ok || st.Seq != 7 || st.Metrics != nil || reads.Load() != 2 {
		t.Fatalf("legacy short poll: ok %v, state %+v, reads %d", ok, st, reads.Load())
	}
}

// TestOwnerTraceCancellationDoesNotRetry ensures that hiding or closing a page
// cancels its long poll without starting another request in the background.
func TestOwnerTraceCancellationDoesNotRetry(t *testing.T) {
	var reads atomic.Int32
	started := make(chan struct{})
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reads.Add(1)
		close(started)
		<-r.Context().Done()
	}))
	defer up.Close()
	t.Setenv("MAGPIE_ADDR", strings.TrimPrefix(up.URL, "http://"))
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	done := make(chan bool, 1)
	go func() { _, ok := OwnerTrace(ctx, 7, time.Second); done <- ok }()
	<-started
	cancel()
	if ok := <-done; ok || reads.Load() != 1 {
		t.Fatalf("canceled read: ok %v, reads %d", ok, reads.Load())
	}
}

// TestRequestMetricsAcrossSleep advances wall time while the monotonic clock
// barely moves, then rolls wall time back. Old entries expire and new ones keep
// a normal sixty-second lifetime instead of reviving or freezing the window.
func TestRequestMetricsAcrossSleep(t *testing.T) {
	var s Server
	_, done := s.active.add(httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil))
	done()
	mono, wall := s.active.rateLast, s.active.rateWall
	s.active.rateSecondAt(mono.Add(2*time.Second), wall.Add(2*time.Hour))
	if m := s.Metrics(mono.Add(3 * time.Second)); m.QPS != 0 {
		t.Fatalf("pre-sleep entries survived wake and clock rollback: %+v", m)
	}
	// Keep the simulated clock moving forward when a new post-wake entry arrives.
	second := s.active.rateSecondAt(mono.Add(4*time.Second), wall.Add(4*time.Second))
	s.active.rateBuckets[second%metricsWindowSeconds] = requestBucket{second: second, requests: 1}
	if m := s.Metrics(mono.Add(5 * time.Second)); m.QPS != 1.0/60 {
		t.Fatalf("new entry after wake: %+v", m)
	}
	if m := s.Metrics(mono.Add(65 * time.Second)); m.QPS != 0 {
		t.Fatalf("post-wake clock stopped advancing: %+v", m)
	}
}

// TestRequestMetricsIgnoresOlderSamples keeps concurrent read arrival order
// from counting the same elapsed interval twice.
func TestRequestMetricsIgnoresOlderSamples(t *testing.T) {
	var clock inflights
	base := time.Now()
	wall := base.Round(0)
	clock.rateSecondAt(base, wall)
	clock.rateSecondAt(base.Add(2*time.Second), wall.Add(2*time.Second))
	clock.rateSecondAt(base.Add(time.Second), wall.Add(time.Second))
	if second := clock.rateSecondAt(base.Add(3*time.Second), wall.Add(3*time.Second)); second != 3 {
		t.Fatalf("an older sample advanced the window twice: %d", second)
	}
}

// TestRequestMetricsOlderSampleAcrossRollback rejects a stale monotonic reading
// whose wall time happens to be ahead after the system clock was corrected.
func TestRequestMetricsOlderSampleAcrossRollback(t *testing.T) {
	var clock inflights
	base := time.Now()
	wall := base.Round(0)
	clock.rateSecondAt(base, wall)
	clock.rateSecondAt(base.Add(2*time.Second), wall.Add(-time.Hour))
	if second := clock.rateSecondAt(base.Add(time.Second), wall.Add(time.Second)); second != 2 {
		t.Fatalf("an old sample across rollback advanced the window: %d", second)
	}
	if second := clock.rateSecondAt(base.Add(3*time.Second), wall.Add(-time.Hour+time.Second)); second != 3 {
		t.Fatalf("clock did not resume after the old sample: %d", second)
	}
}
