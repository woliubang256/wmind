package mcp

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
)

// maxStdioMessageBytes 是单条 stdio 消息的上限：工具参数都很小，1MB 足够。
const maxStdioMessageBytes = 1 << 20

// ServeStdio 在给定的流上跑 MCP 的 stdio 传输。
//
// 协议与 HTTP 版完全一致（JSON-RPC 2.0），区别只在分帧：stdio 用**每行一条
// 消息**（MCP 的 stdio 传输就是这样定义的），读到 EOF 就退出。
//
// stdio 没有令牌可带：能启动这个进程的进程本来就是可信的（客户端自己拉起它），
// 所以鉴权交给「用户是否在设置里开启 MCP」这一道闸门。
func ServeStdio(ctx context.Context, deps Deps, in io.Reader, out io.Writer, logger *slog.Logger) error {
	if deps.Logger == nil {
		deps.Logger = logger
	}
	server := newServer(deps)
	reader := bufio.NewReaderSize(in, 64<<10)
	writer := bufio.NewWriter(out)
	defer func() { _ = writer.Flush() }()

	for {
		if err := ctx.Err(); err != nil {
			return nil
		}
		line, err := readLine(reader, maxStdioMessageBytes)
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		if len(line) == 0 {
			continue
		}
		var req rpcRequest
		if err := json.Unmarshal(line, &req); err != nil {
			response := rpcResponse{JSONRPC: "2.0", Error: &rpcError{Code: codeInvalidRequest, Message: "invalid JSON-RPC request"}}
			if writeErr := writeResponse(writer, response); writeErr != nil {
				return writeErr
			}
			continue
		}
		response, ok := server.serve(ctx, req)
		if !ok {
			continue
		}
		if err := writeResponse(writer, response); err != nil {
			return err
		}
	}
}

// readLine 读一行，超过上限时报错而不是无限吃内存。
func readLine(reader *bufio.Reader, limit int) ([]byte, error) {
	var buf []byte
	for {
		chunk, err := reader.ReadSlice('\n')
		if len(buf)+len(chunk) > limit {
			return nil, errors.New("mcp: stdio message too large")
		}
		buf = append(buf, chunk...)
		switch {
		case err == nil:
			return trimLineEnding(buf), nil
		case errors.Is(err, bufio.ErrBufferFull):
			continue
		case errors.Is(err, io.EOF):
			if len(buf) == 0 {
				return nil, io.EOF
			}
			return trimLineEnding(buf), nil
		default:
			return nil, err
		}
	}
}

func trimLineEnding(buf []byte) []byte {
	for len(buf) > 0 && (buf[len(buf)-1] == '\n' || buf[len(buf)-1] == '\r') {
		buf = buf[:len(buf)-1]
	}
	return buf
}

func writeResponse(writer *bufio.Writer, response rpcResponse) error {
	payload, err := json.Marshal(response)
	if err != nil {
		return err
	}
	if _, err := writer.Write(append(payload, '\n')); err != nil {
		return err
	}
	// 每条响应立即刷出去：客户端在等这一条。
	return writer.Flush()
}
