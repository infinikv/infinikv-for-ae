#include <pybind11/pybind11.h>
#include <pybind11/stl.h>
#include <torch/extension.h>
#include <cuda_runtime.h>
#include <ATen/cuda/CUDAContext.h>
#include "geminifs.cuh"

// Wrapper function for geminifs_gpu_open_file to handle reference parameter
std::tuple<bool, uint32_t> geminifs_gpu_open_file_wrapper(GeminiFS& self,
                                                          int device_id) {
  GPUFileId gpu_file_id;
  bool success = self.geminifs_gpu_open_file(device_id, gpu_file_id);
  return std::make_tuple(success, gpu_file_id);
}

// Wrapper functions for batched operations using stream ID
bool geminifs_batched_read_wrapper(GeminiFS& self,
                                   std::vector<torch::Tensor>& k_caches,
                                   std::vector<torch::Tensor>& v_caches,
                                   const std::vector<GPUFileId>& gpu_file_ids,
                                   int layer_id,
                                   GPUControllerPtr gpu_controller,
                                   int64_t stream_id) {
  // Convert stream ID to cudaStream_t
  cudaStream_t stream = reinterpret_cast<cudaStream_t>(stream_id);
  return self.geminifs_batched_read(k_caches, v_caches, gpu_file_ids, layer_id,
                                    gpu_controller, stream);
}

bool geminifs_batched_write_wrapper(GeminiFS& self,
                                    const std::vector<torch::Tensor>& k_caches,
                                    const std::vector<torch::Tensor>& v_caches,
                                    const std::vector<GPUFileId>& gpu_file_ids,
                                    int layer_id,
                                    GPUControllerPtr gpu_controller,
                                    int64_t stream_id) {
  // Convert stream ID to cudaStream_t
  cudaStream_t stream = reinterpret_cast<cudaStream_t>(stream_id);
  return self.geminifs_batched_write(k_caches, v_caches, gpu_file_ids, layer_id,
                                     gpu_controller, stream);
}

// // Unified (MLA) wrappers: single tensor per layer, no K/V split
// bool geminifs_batched_read_unified_wrapper(GeminiFS& self,
//                                             std::vector<torch::Tensor>& caches,
//                                             const std::vector<GPUFileId>& gpu_file_ids,
//                                             int layer_id,
//                                             GPUControllerPtr gpu_controller,
//                                             int64_t stream_id) {
//   cudaStream_t stream = reinterpret_cast<cudaStream_t>(stream_id);
//   return self.geminifs_batched_read_unified(caches, gpu_file_ids, layer_id,
//                                              gpu_controller, stream);
// }

// bool geminifs_batched_write_unified_wrapper(GeminiFS& self,
//                                              const std::vector<torch::Tensor>& caches,
//                                              const std::vector<GPUFileId>& gpu_file_ids,
//                                              int layer_id,
//                                              GPUControllerPtr gpu_controller,
//                                              int64_t stream_id) {
//   cudaStream_t stream = reinterpret_cast<cudaStream_t>(stream_id);
//   return self.geminifs_batched_write_unified(caches, gpu_file_ids, layer_id,
//                                               gpu_controller, stream);
// }

namespace py = pybind11;

PYBIND11_MODULE(c_ops, m) {
  m.doc() = "GeminiFS Python bindings";

  py::class_<GPUController, GPUControllerPtr>(m, "GPUController")
      .def(py::init<int, const std::string&>(), py::arg("device_id"),
           py::arg("mount_base_path"));

  // Bind GeminiFS class
  py::class_<GeminiFS>(m, "GeminiFS")
      .def(
          py::init<const std::string&, int, const std::vector<size_t>&, bool>(),
          py::arg("config_file_path"), py::arg("gpu_file_nums"),
          py::arg("gpu_file_shape"), py::arg("reset") = false)

      // geminifs_batched_read overloads
      .def("geminifs_batched_read", &geminifs_batched_read_wrapper,
           py::arg("k_caches"), py::arg("v_caches"), py::arg("gpu_file_ids"),
           py::arg("layer_id"), py::arg("gpu_controller"), py::arg("stream_id"))

      .def("geminifs_batched_write", &geminifs_batched_write_wrapper,
           py::arg("k_caches"), py::arg("v_caches"), py::arg("gpu_file_ids"),
           py::arg("layer_id"), py::arg("gpu_controller"), py::arg("stream_id"))

      // Unified (MLA) variants: single tensor per layer
     //  .def("geminifs_batched_read_unified", &geminifs_batched_read_unified_wrapper,
     //       py::arg("caches"), py::arg("gpu_file_ids"),
     //       py::arg("layer_id"), py::arg("gpu_controller"), py::arg("stream_id"))

     //  .def("geminifs_batched_write_unified", &geminifs_batched_write_unified_wrapper,
     //       py::arg("caches"), py::arg("gpu_file_ids"),
     //       py::arg("layer_id"), py::arg("gpu_controller"), py::arg("stream_id"))

      //    .def("geminifs_create_gpu_controller",
      //    &GeminiFS::geminifs_create_gpu_controller)
      .def("geminifs_get_gpu_controller",
           &GeminiFS::geminifs_get_gpu_controller, py::arg("device_id"))

      // Tensor operations
      .def("geminifs_register_tensor_with_gpu",
           &GeminiFS::geminifs_register_tensor_with_gpu, py::arg("tensor"),
           py::arg("granularity") = 0)
      // .def("geminifs_register_tensors_with_gpu",
      //      &GeminiFS::geminifs_register_tensors_with_gpu,
      //      py::arg("tensor_list"), py::arg("granularity") = 0)
      .def("geminifs_unregister_tensor_from_gpu",
           &GeminiFS::geminifs_unregister_tensor_from_gpu, py::arg("tensor"))
      // .def("geminifs_get_tensor_dma_from_gpu",
      // &GeminiFS::geminifs_get_tensor_dma_from_gpu,
      //     py::return_value_policy::reference_internal)

      // File operations
      .def("geminifs_gpu_open_file", &geminifs_gpu_open_file_wrapper,
           py::arg("device_id"));
}