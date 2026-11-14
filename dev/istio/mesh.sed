# Turns dev/beyla/40-demo-traffic.yaml into its Istio ambient copy
# (`make demo-mesh`): the same apps in their own namespaces, so the plain and
# the meshed copy sit side by side and both sources (Beyla and Istio) have
# traffic to report. One source for both, so they can't drift apart.
#
#   demo-frontend -> mesh-frontend    demo-backend -> mesh-backend
#
# The namespaces and the backend URL the frontend calls follow from the
# rename. Workload names stay frontend/backend; the namespace tells the
# copies apart.
s/demo-frontend/mesh-frontend/g
s/demo-backend/mesh-backend/g
# Enroll both namespaces in the ambient mesh: the CNI agent redirects their
# pods' traffic through ztunnel (mTLS between them, no sidecars). The
# Namespace objects are the only ones with a top-level "  name: mesh-...".
# mesh-backend also routes traffic to its services through the namespace's
# waypoint (dev/istio/mesh.yaml): the L7 proxy that reports
# istio_requests_total for frontend -> backend calls. Without it the mesh
# only has ztunnel's L4 istio_tcp_* metrics.
s/^  name: mesh-backend$/  name: mesh-backend\n  labels:\n    istio.io\/dataplane-mode: ambient\n    istio.io\/use-waypoint: waypoint/
s/^  name: \(mesh-[a-z]*\)$/  name: \1\n  labels:\n    istio.io\/dataplane-mode: ambient/
