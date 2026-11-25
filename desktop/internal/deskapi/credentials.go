package deskapi

import (
	"errors"
	"sync"

	"github.com/woliubang256/wmind/backend/desktop/internal/cloud"
	"github.com/woliubang256/wmind/backend/desktop/internal/cloudcreds"
)

// CredentialStore coordinates encrypted persistence with login and logout.
type CredentialStore struct {
	Repo       CredentialRepo
	mu         sync.Mutex
	generation uint64
}

type CredentialRepo interface {
	Load() (*cloudcreds.Credentials, error)
	Save(cloudcreds.Credentials) error
	Clear() error
}

func (c *CredentialStore) Load() (*cloudcreds.Credentials, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.Repo.Load()
}

func (c *CredentialStore) Save(creds cloudcreds.Credentials) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.Repo.Save(creds)
}

func (c *CredentialStore) Clear() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.generation++
	return c.Repo.Clear()
}

func credentialsForSession(session cloud.Session, identifier string) cloudcreds.Credentials {
	return cloudcreds.Credentials{
		ServerURL: session.ServerURL, Identifier: identifier,
		Email: session.UserEmail, UserUID: session.UserUID,
		Role: session.Role, Nickname: session.Nickname,
		RefreshToken: session.RefreshToken, RefreshExpiresAt: session.RefreshExpiresAt,
	}
}

// Attach persists a newly logged-in/restored client before publishing it. A
// superseded client's late refresh cannot recreate or overwrite stored sessions.
func (c *CredentialStore) Attach(client *cloud.Client, identifier string) error {
	initial := credentialsForSession(client.Session(), identifier)
	c.mu.Lock()
	if err := c.Repo.Save(initial); err != nil {
		c.mu.Unlock()
		return err
	}
	c.generation++
	generation := c.generation
	c.mu.Unlock()
	client.SetSessionSaver(func(session cloud.Session) error {
		c.mu.Lock()
		defer c.mu.Unlock()
		if c.generation != generation {
			return errors.New("cloud session was replaced or signed out")
		}
		return c.Repo.Save(credentialsForSession(session, identifier))
	})
	return nil
}
