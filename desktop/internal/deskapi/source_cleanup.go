package deskapi

import (
	"net/http"
)

func (a *api) deleteMapSource(w http.ResponseWriter, r *http.Request) {
	if a.deps.Sources == nil {
		writeJSON(w, http.StatusOK, envelope{Data: map[string]bool{"deleted": false}})
		return
	}
	if err := a.deps.Sources.Delete(r.Context(), r.PathValue("uid")); err != nil {
		fail(w, http.StatusInternalServerError, errorText(err))
		return
	}
	writeJSON(w, http.StatusOK, envelope{Data: map[string]bool{"deleted": true}})
}

func (a *api) deleteAllMapSources(w http.ResponseWriter, r *http.Request) {
	if a.deps.Sources == nil {
		writeJSON(w, http.StatusOK, envelope{Data: map[string]bool{"deleted": false}})
		return
	}
	if err := a.deps.Sources.DeleteAll(r.Context()); err != nil {
		fail(w, http.StatusInternalServerError, errorText(err))
		return
	}
	writeJSON(w, http.StatusOK, envelope{Data: map[string]bool{"deleted": true}})
}
