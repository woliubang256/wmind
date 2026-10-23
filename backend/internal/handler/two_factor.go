package handler

import (
	"github.com/gin-gonic/gin"
	"github.com/woliubang256/wmind/backend/internal/httpapi/middleware"
	"github.com/woliubang256/wmind/backend/internal/httpapi/response"
	"github.com/woliubang256/wmind/backend/internal/pkg/apperr"
)

type twoFactorRequest struct {
	Password       string `json:"password"`
	Code           string `json:"code"`
	ChallengeToken string `json:"challengeToken"`
}

func bindTwoFactor(c *gin.Context) (*twoFactorRequest, bool) {
	c.Header("Cache-Control", "no-store")
	var req twoFactorRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, apperr.Wrap(apperr.CodeBadRequest, err))
		return nil, false
	}
	return &req, true
}
func (h *AuthHandler) VerifyTwoFactor(c *gin.Context) {
	req, ok := bindTwoFactor(c)
	if !ok {
		return
	}
	result, err := h.svc.VerifyTwoFactorLogin(c.Request.Context(), req.ChallengeToken, req.Code, h.sessionMeta(c))
	if err != nil {
		response.Fail(c, err)
		return
	}
	h.setRefreshCookie(c, result)
	response.OK(c, toAuthResponse(result))
}
func (h *AuthHandler) TwoFactorStatus(c *gin.Context) {
	c.Header("Cache-Control", "no-store")
	status, err := h.svc.TwoFactorStatus(c.Request.Context(), middleware.UserID(c))
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, status)
}
func (h *AuthHandler) SetupTwoFactor(c *gin.Context) {
	req, ok := bindTwoFactor(c)
	if !ok {
		return
	}
	result, err := h.svc.SetupTwoFactor(c.Request.Context(), middleware.UserID(c), req.Password)
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, result)
}
func (h *AuthHandler) EnableTwoFactor(c *gin.Context) {
	req, ok := bindTwoFactor(c)
	if !ok {
		return
	}
	result, err := h.svc.EnableTwoFactor(c.Request.Context(), middleware.UserID(c), req.Password, req.Code)
	if err != nil {
		response.Fail(c, err)
		return
	}
	h.setRefreshCookie(c, result.Session)
	response.OK(c, gin.H{"session": toAuthResponse(result.Session), "recoveryCodes": result.RecoveryCodes})
}
func (h *AuthHandler) DisableTwoFactor(c *gin.Context)        { h.changeTwoFactor(c, true) }
func (h *AuthHandler) RegenerateRecoveryCodes(c *gin.Context) { h.changeTwoFactor(c, false) }
func (h *AuthHandler) changeTwoFactor(c *gin.Context, disable bool) {
	req, ok := bindTwoFactor(c)
	if !ok {
		return
	}
	result, err := h.svc.ChangeTwoFactor(c.Request.Context(), middleware.UserID(c), req.Password, req.Code, disable)
	if err != nil {
		response.Fail(c, err)
		return
	}
	if result.Session != nil {
		h.setRefreshCookie(c, result.Session)
		response.OK(c, gin.H{"session": toAuthResponse(result.Session)})
		return
	}
	response.OK(c, gin.H{"recoveryCodes": result.RecoveryCodes})
}
