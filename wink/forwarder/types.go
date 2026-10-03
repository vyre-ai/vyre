package main

import (
	"context"

	"tailscale.com/client/local"
	"tailscale.com/ipn"
	"tailscale.com/client/tailscale/apitype"
)

type apitypeWho = apitype.WhoIsResponse

// whoIsClient is the one LocalAPI call handle needs; tests supply a fake.
type whoIsClient interface {
	WhoIs(ctx context.Context, remoteAddr string) (*apitype.WhoIsResponse, error)
}

type prefsClient interface {
	GetPrefs(ctx context.Context) (*ipn.Prefs, error)
	EditPrefs(ctx context.Context, mp *ipn.MaskedPrefs) (*ipn.Prefs, error)
}

var _ whoIsClient = (*local.Client)(nil)
var _ prefsClient = (*local.Client)(nil)
