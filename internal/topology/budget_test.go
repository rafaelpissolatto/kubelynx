package topology_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	promapi "github.com/prometheus/client_golang/api"
	promv1 "github.com/prometheus/client_golang/api/prometheus/v1"

	"github.com/rafaelpissolatto/kubelynx/internal/topology"
)

const emptyVectorBody = `{"status":"success","data":{"resultType":"vector","result":[]}}`

func countBody(n int) string {
	return fmt.Sprintf(`{"status":"success","data":{"resultType":"vector","result":[{"metric":{},"value":[1700000000,"%d"]}]}}`, n)
}

// fakeResponse is one canned Prometheus reply; status 0 means 200.
type fakeResponse struct {
	status int
	body   string
}

// newSequenceAPI returns a fake Prometheus that serves responses in order,
// repeating the last one once the sequence is exhausted.
func newSequenceAPI(t *testing.T, responses ...fakeResponse) promv1.API {
	t.Helper()
	var (
		mu sync.Mutex
		i  int
	)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		mu.Lock()
		resp := responses[min(i, len(responses)-1)]
		i++
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		if resp.status != 0 {
			w.WriteHeader(resp.status)
		}
		fmt.Fprint(w, resp.body)
	}))
	t.Cleanup(srv.Close)

	client, err := promapi.NewClient(promapi.Config{Address: srv.URL})
	if err != nil {
		t.Fatalf("creating prometheus client: %v", err)
	}
	return promv1.NewAPI(client)
}

type logRecord struct {
	Level  string  `json:"level"`
	Msg    string  `json:"msg"`
	Series float64 `json:"series"`
	Budget float64 `json:"budget"`
	Error  string  `json:"error"`
}

func newBudget(t *testing.T, budget int, responses ...fakeResponse) (*topology.FlowSeriesBudget, *bytes.Buffer) {
	t.Helper()
	var buf bytes.Buffer
	return &topology.FlowSeriesBudget{
		API:    newSequenceAPI(t, responses...),
		Budget: budget,
		Logger: slog.New(slog.NewJSONHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})),
	}, &buf
}

// records decodes the JSON log lines at Info level and above.
func records(t *testing.T, buf *bytes.Buffer) []logRecord {
	t.Helper()
	var out []logRecord
	dec := json.NewDecoder(bytes.NewReader(buf.Bytes()))
	for dec.More() {
		var r logRecord
		if err := dec.Decode(&r); err != nil {
			t.Fatalf("decoding log record: %v", err)
		}
		if r.Level != "DEBUG" {
			out = append(out, r)
		}
	}
	return out
}

func TestFlowSeriesBudget_BelowBudget_NoWarning(t *testing.T) {
	b, buf := newBudget(t, 1000, fakeResponse{body: countBody(133)})
	b.Check(context.Background())

	if got := records(t, buf); len(got) != 0 {
		t.Errorf("records = %+v, want none", got)
	}
}

func TestFlowSeriesBudget_AboveBudget_WarnsOnce(t *testing.T) {
	b, buf := newBudget(t, 1000, fakeResponse{body: countBody(1500)})
	for range 3 {
		b.Check(context.Background())
	}

	got := records(t, buf)
	if len(got) != 1 {
		t.Fatalf("records = %+v, want exactly one WARN", got)
	}
	r := got[0]
	if r.Level != "WARN" || r.Msg != "flow series over budget" || r.Series != 1500 || r.Budget != 1000 {
		t.Errorf("record = %+v, want WARN flow series over budget series=1500 budget=1000", r)
	}
}

func TestFlowSeriesBudget_AboveThenBelow_WarnThenInfo(t *testing.T) {
	b, buf := newBudget(t, 1000,
		fakeResponse{body: countBody(1500)},
		fakeResponse{body: countBody(400)},
		fakeResponse{body: countBody(400)},
	)
	for range 3 {
		b.Check(context.Background())
	}

	got := records(t, buf)
	if len(got) != 2 {
		t.Fatalf("records = %+v, want WARN then INFO", got)
	}
	if got[0].Level != "WARN" {
		t.Errorf("first record = %+v, want WARN", got[0])
	}
	if got[1].Level != "INFO" || got[1].Series != 400 || got[1].Budget != 1000 {
		t.Errorf("second record = %+v, want INFO series=400 budget=1000", got[1])
	}
}

func TestFlowSeriesBudget_ExactlyAtBudget_NoWarning(t *testing.T) {
	b, buf := newBudget(t, 1000, fakeResponse{body: countBody(1000)})
	b.Check(context.Background())

	if got := records(t, buf); len(got) != 0 {
		t.Errorf("records = %+v, want none at exactly the budget", got)
	}
}

func TestFlowSeriesBudget_EmptyVector_NoWarning(t *testing.T) {
	b, buf := newBudget(t, 1000, fakeResponse{body: emptyVectorBody})
	b.Check(context.Background())

	if got := records(t, buf); len(got) != 0 {
		t.Errorf("records = %+v, want none for an Istio-only cluster", got)
	}
}

func TestFlowSeriesBudget_PrometheusError_WarnsAndKeepsState(t *testing.T) {
	errBody := `{"status":"error","errorType":"internal","error":"boom"}`
	b, buf := newBudget(t, 1000,
		fakeResponse{status: http.StatusInternalServerError, body: errBody},
		fakeResponse{body: countBody(1500)},
		fakeResponse{status: http.StatusInternalServerError, body: errBody},
		fakeResponse{body: countBody(1500)},
	)
	for range 4 {
		b.Check(context.Background())
	}

	got := records(t, buf)
	// error, over-budget transition, error, then silence: the second error
	// must not reset the "over" state, so the last check doesn't re-warn.
	if len(got) != 3 {
		t.Fatalf("records = %+v, want 3 (error, over budget, error)", got)
	}
	for _, i := range []int{0, 2} {
		if got[i].Level != "WARN" || got[i].Error == "" {
			t.Errorf("record %d = %+v, want WARN carrying the error", i, got[i])
		}
	}
	if got[1].Msg != "flow series over budget" {
		t.Errorf("record 1 = %+v, want the over-budget warning", got[1])
	}
}

func TestFlowSeriesBudget_Run_ReturnsOnCancel(t *testing.T) {
	b, buf := newBudget(t, 1000, fakeResponse{body: countBody(1500)})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		b.Run(ctx, time.Millisecond)
		close(done)
	}()
	time.Sleep(20 * time.Millisecond)
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Run did not return after ctx was cancelled")
	}
	if got := records(t, buf); len(got) != 1 {
		t.Errorf("records = %+v, want one WARN across many ticks", got)
	}
}
