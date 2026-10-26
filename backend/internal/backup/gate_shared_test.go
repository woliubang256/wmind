package backup

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestSeparateInstancesShareMaintenanceGate(t *testing.T) {
	root := t.TempDir()
	first, err := NewSharedGate(root)
	if err != nil {
		t.Fatal(err)
	}
	second, err := NewSharedGate(root)
	if err != nil {
		t.Fatal(err)
	}
	resume := first.Pause()
	defer resume()
	if leave, ok := second.Enter(); ok {
		leave()
		t.Fatal("second instance entered while another instance was deleting files")
	}
}

func TestSharedGateDrainsOtherInstanceAndCancels(t *testing.T) {
	root := t.TempDir()
	first, _ := NewSharedGate(root)
	second, _ := NewSharedGate(root)
	leave, ok := first.Enter()
	if !ok {
		t.Fatal("shared enter")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 50*time.Millisecond)
	defer cancel()
	if _, err := second.PauseContext(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("cancel = %v", err)
	}
	if _, ok, err := second.TryPause(); ok || err != nil {
		t.Fatalf("busy try = %v %v", ok, err)
	}
	leave()
	resume, ok, err := second.TryPause()
	if !ok || err != nil {
		t.Fatalf("released try = %v %v", ok, err)
	}
	resume()
}

func TestSharedGateFailsClosedOnUnsafeLock(t *testing.T) {
	root := t.TempDir()
	gate, err := NewSharedGate(root)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(gate.lockPath); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(gate.lockPath, 0700); err != nil {
		t.Fatal(err)
	}
	if leave, ok := gate.Enter(); ok {
		leave()
		t.Fatal("unsafe lock allowed entry")
	}
	if _, err := gate.PauseContext(t.Context()); err == nil {
		t.Fatal("unsafe lock allowed maintenance")
	}
}

func TestSharedGateAcrossProcess(t *testing.T) {
	if root := os.Getenv("WMIND_GATE_TEST_ROOT"); root != "" {
		gate, err := NewSharedGate(root)
		if err != nil {
			t.Fatal(err)
		}
		if leave, ok := gate.Enter(); ok {
			leave()
			t.Fatal("child entered exclusive parent")
		}
		return
	}
	root := t.TempDir()
	gate, err := NewSharedGate(root)
	if err != nil {
		t.Fatal(err)
	}
	resume := gate.Pause()
	defer resume()
	cmd := exec.CommandContext(t.Context(), os.Args[0], "-test.run=^TestSharedGateAcrossProcess$")
	cmd.Env = append(os.Environ(), "WMIND_GATE_TEST_ROOT="+filepath.Clean(root))
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("child: %v %s", err, output)
	}
}
