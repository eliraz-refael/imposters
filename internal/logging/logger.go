package logging

import (
	"fmt"

	"github.com/sirupsen/logrus"
)

type Logger struct {
	*logrus.Logger
	imposterName string
	imposterPort int
}

// NewLogger creates a new logger instance for an imposter
func NewLogger(name string, port int) *Logger {
	logger := logrus.New()

	// Custom formatter that matches our spec: [name:port] timestamp level message
	logger.SetFormatter(&CustomFormatter{
		name: name,
		port: port,
	})

	logger.SetLevel(logrus.InfoLevel)

	return &Logger{
		Logger:       logger,
		imposterName: name,
		imposterPort: port,
	}
}

// NewGlobalLogger creates a logger for non-imposter specific logging (like main.go)
func NewGlobalLogger() *Logger {
	logger := logrus.New()

	logger.SetFormatter(&logrus.TextFormatter{
		FullTimestamp:   true,
		TimestampFormat: "2006-01-02T15:04:05Z07:00",
	})

	logger.SetLevel(logrus.InfoLevel)

	return &Logger{
		Logger: logger,
	}
}

// CustomFormatter implements our log format: [name:port] timestamp level message
type CustomFormatter struct {
	name string
	port int
}

func (f *CustomFormatter) Format(entry *logrus.Entry) ([]byte, error) {
	timestamp := entry.Time.Format("2006-01-02T15:04:05Z07:00")
	level := entry.Level.String()
	message := entry.Message

	// Format: [name:port] timestamp level message
	logLine := fmt.Sprintf("[%s:%d] %s %s %s\n",
		f.name, f.port, timestamp, level, message)

	return []byte(logLine), nil
}

// Helper methods for common log patterns
func (l *Logger) InfoRequest(method, path, clientIP string) {
	l.WithFields(logrus.Fields{
		"method":    method,
		"path":      path,
		"client_ip": clientIP,
	}).Infof("<- %s %s from %s", method, path, clientIP)
}

func (l *Logger) InfoResponse(status int, method, path string, size int64, duration string) {
	l.WithFields(logrus.Fields{
		"status":   status,
		"method":   method,
		"path":     path,
		"size":     size,
		"duration": duration,
	}).Infof("-> %d %s %s (%d bytes, %s)", status, method, path, size, duration)
}

func (l *Logger) WarnNoRoute(method, path string, duration string) {
	l.WithFields(logrus.Fields{
		"method":   method,
		"path":     path,
		"duration": duration,
	}).Warnf("-> 404 %s %s (no matching route, %s)", method, path, duration)
}
