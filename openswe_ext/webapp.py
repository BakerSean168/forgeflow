"""ForgeFlow HTTP extension of the upstream Open SWE FastAPI application."""

from agent.webapp import app

from forgeflow.operator_api import router as forgeflow_operator_router

app.include_router(forgeflow_operator_router)

__all__ = ["app"]
